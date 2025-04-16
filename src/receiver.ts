/**
 * @file receiver.ts
 * Handles the logic for the receiver side of the file transfer:
 * - Starting and stopping the QR code scanner (camera).
 * - Processing scanned QR codes (handshake, data, final).
 * - Assembling received data chunks.
 * - Verifying data integrity (size, checksum).
 * - Handling missing chunks.
 * - Triggering the final file download.
 * - Updating receiver UI elements.
 */

import QrScanner from "qr-scanner";
import JSZip from "jszip";
import * as config from "./config";
import * as dom from "./dom";
import * as state from "./state";
import * as types from "./types";
import * as utils from "./utils";

/**
 * Updates the main status message on the receiver view.
 * @param message - The status message to display.
 * @param isError - Optional: Whether the status indicates an error (displays in red). Defaults to false.
 */
export function updateReceiverStatus(message: string, isError = false): void {
    const statusPrefix = isError ? "Error: " : "Status: ";
    dom.receiverStatus.textContent = `${statusPrefix}${message}`;
    dom.receiverStatus.style.color = isError ? "red" : "inherit";
    // console.log(`Receiver Status: ${message}`); // Optional debug logging
    if (isError) {
        state.setReceiverState("error"); // Set state to error on UI error message
    }
}

/**
 * Updates the progress bar based on the ratio of received chunks to expected chunks.
 */
export function updateReceiverProgress(): void {
    const currentState = state.getState();
    if (
        currentState.expectedTotalChunks !== null &&
        currentState.expectedTotalChunks > 0 &&
        currentState.receivedChunkCount >= 0 // Ensure count is non-negative
    ) {
        const percentage = Math.min(
            100, // Cap at 100%
            Math.round(
                (currentState.receivedChunkCount /
                    currentState.expectedTotalChunks) *
                    100
            )
        );
        dom.receiverProgress.value = percentage;
    } else {
        // Reset progress if no chunks expected or count is invalid
        dom.receiverProgress.value = 0;
    }
}

/**
 * Starts the QR code scanning process using the device camera.
 */
export function startScan(): void {
    const currentState = state.getState();
    if (currentState.isScanning) {
        console.warn("Scanner start requested, but already scanning.");
        return;
    }

    // --- 1. Reset Receiver State ---
    // Only reset core transfer state, keep scanner instance if it exists but was stopped
    state.resetReceiverStateInternal();
    updateReceiverUI(); // Update UI elements to reflect the reset state
    state.setReceiverState("waiting_handshake"); // Set initial state
    updateReceiverStatus("Initializing camera...");
    dom.missingChunksInfo.classList.add("hidden"); // Hide missing chunks info

    // Reset rate calculation variables
    state.setReceiverStartTime(performance.now());
    state.setReceiverLastRateUpdateTime(state.getState().receiverStartTime);
    state.setReceiverBytesSinceLastUpdate(0);
    state.setReceiverCurrentRateBps(null);
    dom.receiverTransferRate.textContent = "";

    // --- 2. Initialize or Reuse Scanner Instance ---
    let scannerInstance = currentState.qrScanner;
    if (!scannerInstance) {
        console.log("Creating new QrScanner instance.");
        scannerInstance = new QrScanner(
            dom.receiverVideo,
            handleScanResult, // Callback for successful scans
            {
                onDecodeError: handleScanError, // Callback for decoding errors
                // Calculate scan region to use the entire video feed
                calculateScanRegion: (videoElement) => ({
                    x: 0,
                    y: 0,
                    width: videoElement.videoWidth,
                    height: videoElement.videoHeight,
                }),
                highlightScanRegion: true, // Draw border around scan area
                highlightCodeOutline: true, // Draw outline around detected QR codes
            }
        );
        state.setQrScanner(scannerInstance); // Store the new instance in state
    } else {
        console.log("Reusing existing QrScanner instance.");
    }

    // --- 3. Start the Scanner ---
    scannerInstance
        .start()
        .then(() => {
            state.setIsScanning(true); // Update scanning status in state
            // Update UI Controls
            dom.startScanBtn.disabled = true;
            dom.stopScanBtn.disabled = false;
            updateReceiverStatus(
                "Scanning active. Waiting for Handshake QR..."
            );
            dom.receiverVideoContainer.style.border = "2px solid green"; // Indicate active scan
        })
        .catch((err) => {
            console.error("Error starting scanner:", err);
            let message = "Error starting scanner.";
            if (err?.name === "NotAllowedError") {
                message = "Camera access denied. Please grant permission.";
            } else if (err?.name === "NotFoundError") {
                message = "No camera found.";
            } else if (err instanceof Error) {
                message = `Scanner Error: ${err.message}`;
            }
            updateReceiverStatus(message, true);
            dom.receiverVideoContainer.style.border = "2px solid red"; // Indicate error
            state.resetReceiverStateInternal(); // Reset state fully on start error
            state.setQrScanner(null); // Dispose of potentially broken scanner instance
            state.setIsScanning(false); // Ensure scanning is false
            updateReceiverUI(); // Refresh UI
            dom.startScanBtn.disabled = false; // Re-enable start button
            dom.stopScanBtn.disabled = true;
        });
}

/**
 * Stops the active QR code scanner and cleans up resources.
 */
export function stopScan(): void {
    const currentState = state.getState();
    if (!currentState.isScanning || !currentState.qrScanner) {
        console.log("Stop scan requested, but not currently scanning.");
        return;
    }

    console.log("Stopping QR Scanner...");
    try {
        currentState.qrScanner.stop(); // Stop video feed processing
        currentState.qrScanner.destroy(); // Release resources
        console.log("QR Scanner stopped and destroyed.");
    } catch (e) {
        console.warn("Error during scanner stop/destroy:", e);
    }

    // Update state and UI
    state.setQrScanner(null); // Remove instance from state
    state.setIsScanning(false);
    dom.startScanBtn.disabled = false;
    dom.stopScanBtn.disabled = true;

    // Update status unless already completed or errored out
    if (!["complete", "error"].includes(currentState.receiverState)) {
        updateReceiverStatus("Scanning stopped.");
    }
    dom.receiverVideoContainer.style.border = "1px solid grey"; // Reset border
    dom.receiverTransferRate.textContent = ""; // Clear rate display
}

/**
 * Handles errors reported by the QrScanner library during decoding attempts.
 * Used to reduce console noise from failed scan attempts.
 * @param error - The error object from QrScanner.
 */
function handleScanError(error: Error | string): void {
    // Ignore common errors that just mean no QR code was found or decoded yet
    if (error && typeof error === "object" && "name" in error) {
        if (
            error.name === "NotFoundException" ||
            (error as Error).message.includes("No QR code found")
        ) {
            // console.log('No QR code found in this frame.'); // Suppress this frequent message
            return;
        }
    }
    // Log other potentially more significant errors
    console.warn("QR Scan Decode Error:", error);
    dom.receiverDebug.textContent = `ScanErr`; // Optional debug output
}

/**
 * Updates the estimated transfer rate based on received bytes over time.
 * @param bytesReceived - The approximate number of bytes received in the last chunk.
 */
function updateReceiverRate(bytesReceived: number): void {
    const now = performance.now();
    state.addReceiverBytesSinceLastUpdate(bytesReceived); // Add bytes to current interval count

    const currentState = state.getState();
    const timeSinceLastUpdate = now - currentState.receiverLastRateUpdateTime;

    // Update rate if enough time has passed
    if (timeSinceLastUpdate > config.RATE_UPDATE_INTERVAL_MS) {
        const timeDiffSeconds = timeSinceLastUpdate / 1000;
        const bytesSinceLastUpdate = currentState.receiverBytesSinceLastUpdate;

        // Calculate Bps, avoid division by zero or tiny intervals
        const newRateBps =
            timeDiffSeconds > 0.05
                ? bytesSinceLastUpdate / timeDiffSeconds
                : null;

        state.setReceiverCurrentRateBps(newRateBps);
        state.setReceiverLastRateUpdateTime(now); // Reset time for next interval
        state.setReceiverBytesSinceLastUpdate(0); // Reset byte count for next interval

        // Update the UI element
        dom.receiverTransferRate.textContent =
            newRateBps !== null
                ? `Rate: ~${utils.formatBytesPerSecond(newRateBps)}`
                : "";
    }
}

/**
 * Processes the result of a successful QR code scan.
 * Parses the data, validates the payload, and updates the receiver state machine.
 * @param result - The scan result object or string from QrScanner.
 */
export function handleScanResult(result: QrScanner.ScanResult | string): void {
    const dataString = typeof result === "string" ? result : result.data;
    const currentState = state.getState();

    // --- 1. Check Receiver State ---
    // Only process scans if in a state expecting QR codes
    if (
        ![
            "waiting_handshake",
            "receiving_data",
            "waiting_final",
            "waiting_missing",
        ].includes(currentState.receiverState)
    ) {
        // console.log("Ignoring scan result in state:", currentState.receiverState);
        return;
    }

    // --- 2. Parse and Validate Payload ---
    let payload: types.QRPayload;
    try {
        payload = JSON.parse(dataString);

        // Basic validation of payload structure
        if (
            typeof payload !== "object" ||
            payload === null || // Added null check
            typeof payload.v !== "number" || // Use typeof for primitives
            typeof payload.fid !== "string" ||
            typeof payload.typ !== "string" ||
            !payload.fid // Ensure fid is not empty
        ) {
            console.warn("Ignoring invalid payload structure:", payload);
            dom.receiverDebug.textContent = `Struct Err`;
            return;
        }

        // Check protocol version compatibility
        if (payload.v !== config.PROTOCOL_VERSION) {
            updateReceiverStatus(
                `Incompatible protocol version (Received: ${payload.v}, Expected: ${config.PROTOCOL_VERSION}). Stopping.`,
                true
            );
            stopScan();
            return;
        }

        // Ignore packets for a different file transfer (unless waiting for a new handshake)
        if (
            currentState.receiverState !== "waiting_handshake" &&
            currentState.expectedFileId && // Ensure expectedFileId is set
            payload.fid !== currentState.expectedFileId
        ) {
            console.log(
                `Ignoring packet for wrong file ID (Expected: ${currentState.expectedFileId}, Received: ${payload.fid})`
            );
            dom.receiverDebug.textContent = `FID Err`;
            return; // Ignore this packet completely
        }
    } catch (e) {
        console.warn("QR Data Parse Error:", e);
        dom.receiverDebug.textContent = `JSON Err`;
        return; // Ignore unparseable data
    }

    // --- 3. Process Payload based on State Machine ---
    try {
        // Wrap state machine logic in try-catch for robustness
        switch (currentState.receiverState) {
            case "waiting_handshake":
                if (payload.typ === "h") {
                    processHandshake(payload as types.QRHandshakePayload);
                } else if (
                    payload.typ === "f" &&
                    payload.fid === currentState.expectedFileId
                ) {
                    // If we receive the final packet while *still* waiting for handshake (e.g., user restarts scan mid-transfer)
                    // And if it matches an *already known* file ID from a previous attempt.
                    console.log(
                        "Received final packet while waiting for handshake (matching previous ID). Checking completeness..."
                    );
                    handleFinalPacket(payload as types.QRFinalPayload);
                }
                // Ignore data packets ('d') in this state
                break;

            case "receiving_data":
            case "waiting_missing": // Can receive data or final packets in both states
                if (
                    payload.typ === "d" &&
                    payload.fid === currentState.expectedFileId
                ) {
                    processDataChunk(payload as types.QRDataPayload);
                } else if (
                    payload.typ === "f" &&
                    payload.fid === currentState.expectedFileId
                ) {
                    // Process final packet whenever encountered after handshake
                    handleFinalPacket(payload as types.QRFinalPayload);
                }
                // Ignore handshake ('h') or other types here
                break;

            case "waiting_final":
                // Primarily waiting for the final 'f' packet after getting all data chunks
                if (
                    payload.typ === "f" &&
                    payload.fid === currentState.expectedFileId
                ) {
                    handleFinalPacket(payload as types.QRFinalPayload);
                } else if (
                    payload.typ === "d" &&
                    payload.fid === currentState.expectedFileId
                ) {
                    // If sender resends a data chunk while we wait for final, accept it just in case
                    console.log(
                        "Received data chunk while waiting for final. Processing (likely duplicate)."
                    );
                    processDataChunk(payload as types.QRDataPayload);
                }
                // Ignore handshake ('h')
                break;
        }
    } catch (processingError) {
        console.error("Error processing payload:", processingError);
        updateReceiverStatus(
            `Internal error processing packet: ${
                processingError instanceof Error
                    ? processingError.message
                    : String(processingError)
            }`,
            true
        );
        // Consider stopping scan or resetting state depending on severity
        stopScan();
    }
}

/**
 * Processes a received Handshake ('h') payload.
 * @param handshake - The validated handshake payload.
 */
function processHandshake(handshake: types.QRHandshakePayload): void {
    const currentState = state.getState();

    // --- Validate Handshake Specific Fields ---
    if (
        typeof handshake.nam !== "string" ||
        typeof handshake.siz !== "number" ||
        typeof handshake.tot !== "number" ||
        handshake.tot < 0 || // Total chunks cannot be negative
        handshake.zip !== true // Currently mandates zipping
    ) {
        console.warn("Ignoring invalid handshake payload fields:", handshake);
        dom.receiverDebug.textContent = `HShake Field Err`;
        return;
    }

    // --- Process only if it's a new transfer ID or the first handshake ---
    if (
        !currentState.expectedFileId ||
        currentState.expectedFileId !== handshake.fid
    ) {
        console.log(`Processing NEW Handshake. File ID: ${handshake.fid}`);

        // Reset transfer-specific state for the new file
        state.clearReceivedChunks(); // Clear any old chunks
        state.setExpectedFileId(handshake.fid); // Set the expected ID for subsequent packets

        // Decode filenames safely
        const archiveName = utils.safeDecodeURIComponent(
            handshake.nam,
            config.MULTI_FILE_ARCHIVE_NAME
        );
        const originalFilename = handshake.ofn
            ? utils.safeDecodeURIComponent(handshake.ofn, null)
            : null;

        state.setExpectedData(
            archiveName,
            handshake.siz,
            handshake.tot,
            handshake.zip,
            originalFilename
        );

        // Reset rate calculation for the new transfer
        state.setReceiverStartTime(performance.now());
        state.setReceiverLastRateUpdateTime(state.getState().receiverStartTime);
        state.setReceiverBytesSinceLastUpdate(0);
        state.setReceiverCurrentRateBps(null);
        dom.receiverTransferRate.textContent = "";

        // Update UI with file info
        const sizeKB = (handshake.siz / 1024).toFixed(2);
        const fileInfoText = originalFilename
            ? `Single File: ${originalFilename}`
            : `Archive: ${archiveName}`;
        dom.receivedFileInfo.textContent = `${fileInfoText} (${sizeKB} KB). Expected Chunks: ${handshake.tot}.`;

        updateReceiverProgress(); // Update progress bar (will be 0%)
        dom.missingChunksInfo.classList.add("hidden"); // Ensure missing info is hidden initially

        // Transition to next state based on chunk count
        if (handshake.tot === 0) {
            // If no data chunks expected (e.g., empty file)
            updateReceiverStatus(
                `Handshake OK (0 data chunks). Waiting for Final QR...`,
                false
            );
            state.setReceiverState("waiting_final");
        } else {
            updateReceiverStatus(
                `Handshake OK! Receiving chunks for ${archiveName}...`
            );
            state.setReceiverState("receiving_data");
        }
    } else {
        // Ignore duplicate handshake for the same ongoing transfer
        console.log(
            `Ignoring duplicate handshake for File ID: ${handshake.fid}`
        );
    }
}

/**
 * Processes a received Data Chunk ('d') payload.
 * @param dataChunk - The validated data chunk payload.
 */
function processDataChunk(dataChunk: types.QRDataPayload): void {
    const currentState = state.getState();

    // --- Validate Data Chunk Specific Fields ---
    if (
        typeof dataChunk.seq !== "number" ||
        !Number.isInteger(dataChunk.seq) || // Ensure it's an integer
        dataChunk.seq <= 0 || // Sequence number must be positive
        dataChunk.seq > (currentState.expectedTotalChunks ?? 0) || // Cannot exceed total expected
        typeof dataChunk.dat !== "string" || // Data must be a string
        !dataChunk.dat // Data cannot be empty string (unless file is truly empty, handled by tot=0)
    ) {
        console.warn("Ignoring invalid data chunk payload:", dataChunk);
        dom.receiverDebug.textContent = `DChunk Field Err`;
        return;
    }

    // --- Store Chunk if Not Already Received ---
    if (!currentState.receivedChunksMap.has(dataChunk.seq)) {
        state.addReceivedChunk(dataChunk.seq, dataChunk.dat); // Add to state

        // Estimate bytes received and update rate
        const approxBytes = Math.ceil(dataChunk.dat.length * 0.75); // Base64 to bytes estimate
        updateReceiverRate(approxBytes);

        // Update status and progress
        updateReceiverStatus(
            `Received chunk ${dataChunk.seq}/${
                currentState.expectedTotalChunks
            }. Total unique: ${state.getState().receivedChunkCount}.`
        );
        updateReceiverProgress(); // Update progress bar

        // Check if all chunks are now received
        const nowComplete =
            state.getState().receivedChunkCount ===
            currentState.expectedTotalChunks;

        // Handle state transitions based on completeness and current state
        if (currentState.receiverState === "waiting_missing") {
            displayMissingChunks(); // Refresh the list of missing chunks shown to user
            if (nowComplete) {
                updateReceiverStatus(
                    "All missing chunks received! Waiting for Final QR again..."
                );
                dom.missingChunksInfo.classList.add("hidden");
                state.setReceiverState("waiting_final"); // Move to wait for final confirmation
            }
            // else: Still missing chunks, remain in 'waiting_missing' state
        } else if (nowComplete) {
            // Was in 'receiving_data' and now complete
            updateReceiverStatus(
                `All ${currentState.expectedTotalChunks} data chunks received. Waiting for Final QR...`
            );
            state.setReceiverState("waiting_final"); // Move to wait for final confirmation
        }
        // else: Still receiving data, remain in 'receiving_data' state
    } else {
        // console.log(`Ignoring duplicate data chunk: ${dataChunk.seq}`); // Suppress frequent message
        dom.receiverDebug.textContent = `Dup #${dataChunk.seq}`;
    }
}

/**
 * Processes a received Final ('f') payload.
 * Checks for missing chunks and triggers verification/download if complete.
 * @param finalPayload - The validated final payload.
 */
export async function handleFinalPacket(
    finalPayload: types.QRFinalPayload
): Promise<void> {
    const currentState = state.getState();

    // --- Basic Validation ---
    // Ensure it matches the current transfer
    if (finalPayload.fid !== currentState.expectedFileId) {
        console.log(
            `Ignoring final packet for wrong file ID (Expected: ${currentState.expectedFileId}, Received: ${finalPayload.fid})`
        );
        return;
    }
    // Check checksum presence and basic format (simple check)
    if (typeof finalPayload.chk !== "string" || finalPayload.chk.length === 0) {
        updateReceiverStatus(
            "Final packet received, but checksum is missing or invalid! Cannot verify.",
            true
        );
        state.setReceiverState("error");
        stopScan(); // Stop scanning as we can't proceed
        return;
    }

    // --- Update Status and Check Completeness ---
    updateReceiverStatus(
        "Final confirmation QR received. Checking chunk completeness..."
    );
    console.log(
        `Final packet received for ${finalPayload.fid}. Expected checksum: ${finalPayload.chk}`
    );

    // Check if all expected data chunks have been received
    checkForMissingChunksAndFinalize(finalPayload);
}

/**
 * Checks if all expected chunks are received after seeing the final QR.
 * If complete, proceeds to verification. If not, updates UI to show missing chunks
 * and keeps scanning (state changes to 'waiting_missing').
 * @param finalPayload - The final payload containing the checksum.
 */
export function checkForMissingChunksAndFinalize(
    finalPayload: types.QRFinalPayload
): void {
    const currentState = state.getState();

    if (currentState.expectedTotalChunks === null) {
        updateReceiverStatus(
            "Internal Error: Cannot check for missing chunks, total count unknown.",
            true
        );
        state.setReceiverState("error");
        if (currentState.isScanning) stopScan();
        return;
    }
    if (currentState.expectedTotalChunks === 0) {
        // 0 data chunks expected, proceed directly to verification
        console.log("0 data chunks expected. Proceeding to verification.");
        dom.missingChunksInfo.classList.add("hidden");
        verifyAndDownload(finalPayload);
        return;
    }

    // --- Find Missing Chunks ---
    const missingChunks: number[] = [];
    for (let i = 1; i <= currentState.expectedTotalChunks; i++) {
        if (!currentState.receivedChunksMap.has(i)) {
            missingChunks.push(i);
        }
    }

    // --- Handle Result ---
    if (missingChunks.length === 0) {
        // All chunks received!
        console.log("All expected chunks received.");
        dom.missingChunksInfo.classList.add("hidden"); // Ensure missing info is hidden
        // Proceed to verify and download
        verifyAndDownload(finalPayload);
    } else {
        // Chunks are missing
        console.log(
            `Final QR seen, but ${missingChunks.length} chunks still missing.`
        );
        state.setReceiverState("waiting_missing"); // Set state to wait for more data
        displayMissingChunks(); // Show the list of missing chunks in the UI

        // IMPORTANT: Do NOT stop scanning here. Continue scanning to receive the missing chunks.
        if (!currentState.isScanning) {
            // If scanning somehow stopped, try to restart it automatically.
            // This might happen if there was an error or manual stop previously.
            console.warn(
                "Scanner was stopped, but chunks are still missing. Attempting to restart scan..."
            );
            startScan(); // Try to restart
        } else {
            updateReceiverStatus(
                `Waiting for ${missingChunks.length} missing chunk(s). Keep scanning.`
            );
        }
    }
}

/**
 * Formats an array of missing chunk numbers into a user-friendly string with ranges.
 * e.g., [1, 2, 3, 5, 7, 8] -> "1-3, 5, 7-8"
 * @param missing - Sorted array of missing chunk numbers.
 * @returns A formatted string representing the missing chunks.
 */
export function formatMissingChunks(missing: number[]): string {
    if (!missing || missing.length === 0) return "None"; // Handle empty array

    // Ensure sorted (although usually called after finding them sequentially)
    missing.sort((a, b) => a - b);

    const ranges: string[] = [];
    let rangeStart = missing[0];
    let rangeEnd = missing[0];

    for (let i = 1; i < missing.length; i++) {
        if (missing[i] === rangeEnd + 1) {
            // Extend the current range
            rangeEnd = missing[i];
        } else {
            // End previous range and start a new one
            ranges.push(
                rangeStart === rangeEnd
                    ? `${rangeStart}`
                    : `${rangeStart}-${rangeEnd}`
            );
            rangeStart = missing[i];
            rangeEnd = missing[i];
        }
    }
    // Add the last range
    ranges.push(
        rangeStart === rangeEnd ? `${rangeStart}` : `${rangeStart}-${rangeEnd}`
    );

    return ranges.join(", ");
}

/**
 * Updates the UI element to display the list of missing chunks.
 */
export function displayMissingChunks(): void {
    const currentState = state.getState();
    if (currentState.expectedTotalChunks === null) return; // Should not happen if called correctly

    // Find missing chunks again (state might have updated since last check)
    const missing: number[] = [];
    for (let i = 1; i <= currentState.expectedTotalChunks; i++) {
        if (!currentState.receivedChunksMap.has(i)) {
            missing.push(i);
        }
    }

    if (missing.length > 0) {
        dom.missingChunksCount.textContent = `${missing.length}`;
        dom.missingChunksList.textContent = formatMissingChunks(missing);
        dom.missingChunksInfo.classList.remove("hidden"); // Show the info box
        // Update status gently, don't mark as error yet
        updateReceiverStatus(
            `Waiting for ${missing.length} missing chunk(s). Scan the QR codes again.`,
            false
        );
    } else {
        // No chunks missing (or they arrived)
        dom.missingChunksInfo.classList.add("hidden"); // Hide the info box
        if (currentState.receiverState === "waiting_missing") {
            // If we *were* waiting and now they are all here
            updateReceiverStatus(
                "All missing chunks now received! Waiting final confirm again..."
            );
            state.setReceiverState("waiting_final"); // Go back to waiting for 'f'
        }
    }
}

/**
 * Assembles the complete base64 data from received chunks, verifies its integrity
 * (size and checksum against the final payload), and triggers the download.
 * Stops scanning upon completion or verification failure.
 * @param finalPayload - The final payload containing the expected size and checksum.
 */
export async function verifyAndDownload(
    finalPayload: types.QRFinalPayload
): Promise<void> {
    const currentState = state.getState();

    // --- 1. Stop Scanning ---
    // We only reach here if all chunks are believed to be present. Stop the camera.
    if (currentState.isScanning) {
        stopScan();
    }

    // --- 2. Pre-verification Checks ---
    if (
        currentState.expectedTotalChunks === null ||
        currentState.expectedDataSize === null ||
        currentState.expectedArchiveName === null
    ) {
        updateReceiverStatus(
            "Internal Error: Missing file info for verification.",
            true
        );
        state.setReceiverState("error");
        return;
    }
    if (currentState.receivedChunkCount !== currentState.expectedTotalChunks) {
        updateReceiverStatus(
            `Internal Error: Chunk count mismatch (${currentState.receivedChunkCount}/${currentState.expectedTotalChunks}).`,
            true
        );
        state.setReceiverState("error");
        // Maybe show missing chunks again?
        displayMissingChunks();
        return;
    }

    // --- 3. Assemble Base64 Data ---
    updateReceiverStatus("All chunks present. Assembling data...");
    let fullBase64Zip = "";
    const chunkArray: string[] = []; // Use array join for potentially better performance
    try {
        for (let i = 1; i <= currentState.expectedTotalChunks; i++) {
            const chunkData = currentState.receivedChunksMap.get(i);
            if (chunkData) {
                chunkArray.push(chunkData);
            } else {
                // This should not happen if the count check passed, but handle defensively
                throw new Error(
                    `Critical Error: Missing chunk #${i} during final assembly!`
                );
            }
        }
        fullBase64Zip = chunkArray.join(""); // Concatenate all chunks
        // Clear the array to free memory early if possible
        chunkArray.length = 0;
        console.log(`Assembled base64 data length: ${fullBase64Zip.length}`);
    } catch (assemblyError) {
        updateReceiverStatus(
            `Error during data assembly: ${
                assemblyError instanceof Error
                    ? assemblyError.message
                    : String(assemblyError)
            }`,
            true
        );
        state.setReceiverState("error");
        return;
    }

    // --- 4. Decode Base64 and Verify Size ---
    updateReceiverStatus("Decoding and verifying data size...");
    let receivedZipBuffer: ArrayBuffer;
    try {
        receivedZipBuffer = utils.base64ToArrayBuffer(fullBase64Zip);
        // Clear the large base64 string from memory ASAP
        fullBase64Zip = "";

        // Handle potential decoding failure (empty buffer)
        if (
            receivedZipBuffer.byteLength === 0 &&
            currentState.expectedDataSize > 0
        ) {
            throw new Error("Base64 decoding resulted in an empty buffer.");
        }

        // Verify size
        if (receivedZipBuffer.byteLength !== currentState.expectedDataSize) {
            updateReceiverStatus(
                `Verification FAILED: Size mismatch (Expected: ${currentState.expectedDataSize}, Received: ${receivedZipBuffer.byteLength})`,
                true
            );
            state.setReceiverState("error");
            return; // Stop verification
        }
        console.log(
            `Data size matches expected: ${receivedZipBuffer.byteLength} bytes.`
        );
    } catch (decodeError) {
        updateReceiverStatus(
            `Error decoding base64 data: ${
                decodeError instanceof Error
                    ? decodeError.message
                    : String(decodeError)
            }`,
            true
        );
        state.setReceiverState("error");
        return;
    }

    // --- 5. Verify Checksum ---
    updateReceiverStatus("Verifying data checksum...");
    try {
        const calculatedChecksum = utils.calculateChecksum(receivedZipBuffer);
        console.log(
            `Calculated Checksum: ${calculatedChecksum}, Expected Checksum: ${finalPayload.chk}`
        );

        if (calculatedChecksum !== finalPayload.chk) {
            updateReceiverStatus(
                `Verification FAILED: Checksum mismatch! Data is likely corrupt.`,
                true
            );
            state.setReceiverState("error");
            // Optionally: Offer to download the (corrupt) archive anyway? For now, just fail.
            return; // Stop
        }
        console.log("Checksum verification successful!");
        updateReceiverStatus(
            "Data verified (Size & Checksum OK). Preparing download..."
        );
    } catch (checksumError) {
        updateReceiverStatus(
            `Error calculating checksum: ${
                checksumError instanceof Error
                    ? checksumError.message
                    : String(checksumError)
            }`,
            true
        );
        state.setReceiverState("error");
        return;
    }

    // --- 6. Process Verified Data (Extract Single File or Download Archive) ---
    try {
        // Determine filename for download
        const finalFilename =
            currentState.expectedOriginalFilename || // Use original if single file...
            currentState.expectedArchiveName || // ...otherwise use archive name...
            config.MULTI_FILE_ARCHIVE_NAME; // ...fallback to default.

        // If it was originally a single file, try to extract it from the archive
        if (currentState.expectedOriginalFilename) {
            updateReceiverStatus(
                `Extracting single file: ${currentState.expectedOriginalFilename}...`
            );
            try {
                const zip = await JSZip.loadAsync(receivedZipBuffer);
                // Find the file using the original filename stored in state
                const fileInZip = zip.file(
                    currentState.expectedOriginalFilename
                );

                if (fileInZip) {
                    const extractedBuffer = await fileInZip.async(
                        "arraybuffer"
                    );
                    updateReceiverStatus(
                        "Extraction successful! Starting download..."
                    );
                    state.setReceiverState("complete");
                    utils.triggerFileDownload(extractedBuffer, finalFilename); // Download extracted file
                } else {
                    // File not found inside archive - this indicates a mismatch or corruption
                    console.warn(
                        `Original file '${currentState.expectedOriginalFilename}' not found inside the received archive.`
                    );
                    updateReceiverStatus(
                        `Error: Expected file not found in archive. Downloading the raw archive '${finalFilename}' instead.`,
                        true
                    ); // Mark as partial error
                    state.setReceiverState("complete"); // Still complete, but with a warning
                    utils.triggerFileDownload(receivedZipBuffer, finalFilename); // Download the whole archive
                }
            } catch (zipError) {
                console.error(
                    "Error processing ZIP for single file extraction:",
                    zipError
                );
                updateReceiverStatus(
                    `Error extracting file from ZIP. Downloading the raw archive '${finalFilename}' instead.`,
                    true
                );
                state.setReceiverState("complete");
                utils.triggerFileDownload(receivedZipBuffer, finalFilename); // Download the whole archive
            }
        } else {
            // It was multiple files or a folder, download the whole archive directly
            updateReceiverStatus(
                `Archive verified. Starting download: ${finalFilename}...`
            );
            state.setReceiverState("complete");
            utils.triggerFileDownload(receivedZipBuffer, finalFilename); // Download the archive
        }

        // --- 7. Post-Download Cleanup ---
        if (state.getState().receiverState === "complete") {
            // Short delay before final status update allows download prompt to appear
            setTimeout(() => {
                updateReceiverStatus(
                    `Download triggered for ${finalFilename}. Ready for next scan.`
                );
                // Reset state *after* download is triggered, ready for a new transfer
                state.resetReceiverStateInternal();
                updateReceiverUI(); // Update UI to initial state
            }, 100); // 100ms delay
        }
    } catch (downloadError) {
        console.error("Error triggering download:", downloadError);
        updateReceiverStatus(
            `Verification OK, but failed to trigger download: ${
                downloadError instanceof Error
                    ? downloadError.message
                    : String(downloadError)
            }`,
            true
        );
        // State remains 'error' or potentially reset if needed
        state.setReceiverState("error");
        // Don't reset UI here, keep the error message displayed
    }
}

/**
 * Resets the receiver UI elements to their initial state.
 * Called after a successful transfer or when resetting the receiver view.
 */
export function updateReceiverUI(): void {
    // Get the current state to decide the initial message
    const currentState = state.getState();
    if (currentState.receiverState === "idle") {
        updateReceiverStatus("Ready to scan handshake QR.");
    } else if (currentState.receiverState === "error") {
        // Keep the existing error message displayed by updateReceiverStatus
    } else if (currentState.receiverState === "complete") {
        // Status might have already been set by verifyAndDownload, but ensure it's reasonable
        updateReceiverStatus(`Transfer complete. Ready for next scan.`);
    }
    // else: Keep status from intermediate states if called unexpectedly

    updateReceiverProgress(); // Reset/update progress bar
    dom.receivedFileInfo.textContent = ""; // Clear file info area
    dom.receiverDebug.textContent = ""; // Clear debug area
    dom.missingChunksInfo.classList.add("hidden"); // Hide missing chunks list
    dom.receiverTransferRate.textContent = ""; // Clear transfer rate
    dom.receiverVideoContainer.style.border = "1px solid grey"; // Reset video border

    // Ensure scan buttons are in the correct state (start enabled, stop disabled)
    dom.startScanBtn.disabled = currentState.isScanning;
    dom.stopScanBtn.disabled = !currentState.isScanning;
}

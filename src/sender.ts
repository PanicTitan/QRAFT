/**
 * @file sender.ts
 * Handles the logic for the sender side of the file transfer:
 * - File selection and processing (zipping).
 * - Data chunking based on QR code capacity.
 * - Generating and displaying QR codes in sequence.
 * - Managing transfer state (start, stop, progress, resend).
 * - Calculating and displaying estimates (QR count, time).
 * - Updating sender UI elements.
 */

import QRCodeStyling, {
    ErrorCorrectionLevel,
    Options as QRCodeStylingOptions,
} from "qr-code-styling";
import JSZip from "jszip";
import * as config from "./config";
import * as dom from "./dom";
import * as state from "./state";
import * as types from "./types";
import * as utils from "./utils";

// Module-level variable to hold the QR code instance.
let qrCodeInstance: QRCodeStyling | null = null;
// Module-level flag to track if the *current* sequence (main or resend) is manual
let isCurrentSequenceManual = false;

/**
 * Clears the QR code instance. Called when stopping or resetting the transfer.
 */
export function clearQrInstance() {
    // TODO: Check if qrCodeInstance has a specific cleanup method if needed.
    qrCodeInstance = null;
    // Ensure the container is cleared visually as well
    if (dom.qrCodeContainer) {
        dom.qrCodeContainer.innerHTML = "";
    }
}

/**
 * Updates the sender status messages displayed in the main view and the QR modal.
 * @param mainStatusMessage - The primary status message to display.
 * @param isError - Optional: Whether the status indicates an error (displays in red). Defaults to false.
 * @param remainingSeconds - Optional: Estimated remaining transfer time in seconds.
 * @param rateBps - Optional: Current estimated transfer rate in Bytes per second.
 */
export function updateSenderStatus(
    mainStatusMessage: string,
    isError = false,
    remainingSeconds: number | null = null,
    rateBps: number | null = null
): void {
    const currentState = state.getState(); // Use getter
    const statusPrefix = isError ? "Error: " : "Status: ";

    // Update main status line
    dom.senderStatus.textContent = `${statusPrefix}${mainStatusMessage}`;
    dom.senderStatus.style.color = isError ? "red" : "inherit";

    // Calculate rate text (only if rate is provided and not an error)
    const rateText =
        rateBps !== null && !isError
            ? `Rate: ~${utils.formatBytesPerSecond(rateBps)}`
            : "";

    // Update main transfer rate display (only during active transfer phases)
    dom.senderTransferRate.textContent =
        (currentState.senderTransferPhase === "transferring" ||
            currentState.senderTransferPhase === "sending_specific") &&
        !isError
            ? rateText
            : "";

    // Update modal elements if the overlay is visible
    if (!dom.qrOverlay.classList.contains("hidden")) {
        // Update modal status
        dom.qrModalStatus.textContent = mainStatusMessage;
        dom.qrModalStatus.style.color = isError ? "red" : "inherit";

        // Determine if we should show the manual mode indicator
        // Show if either the initial transfer was manual OR the current sequence (resend) is manual
        const showManualIndicator = isCurrentSequenceManual;

        // Update modal time estimate
        if (
            remainingSeconds !== null &&
            isFinite(remainingSeconds) &&
            !isError &&
            !showManualIndicator // Don't show time estimate if manual
        ) {
            dom.qrModalTimeEstimate.textContent = `Est. Remaining: ${utils.formatTime(
                remainingSeconds
            )}`;
        } else if (
            showManualIndicator &&
            ["transferring", "sending_specific", "final_qr_displayed"].includes(
                currentState.senderTransferPhase
            ) &&
            !isError // Don't show manual mode if there's an error blocking progress
        ) {
            // Check which manual mode applies for the text
            const manualText =
                dom.resendManualModeCheckbox.checked &&
                currentState.senderTransferPhase !== "transferring"
                    ? "(Manual Resend - Click Next)"
                    : "(Manual Mode - Click Next)";
            dom.qrModalTimeEstimate.textContent = manualText;
        } else {
            // Clear estimate if not applicable (e.g., error state, post-transfer, automatic mode finished)
            dom.qrModalTimeEstimate.textContent = "";
        }

        // Update modal transfer rate (only during active transfer phases and not manual)
        dom.qrModalTransferRate.textContent =
            (currentState.senderTransferPhase === "transferring" ||
                currentState.senderTransferPhase === "sending_specific") &&
            !isError &&
            !showManualIndicator // Hide rate in manual mode
                ? rateText
                : "";
    }
}

/**
 * Updates the default chunk size input based on the selected error correction level.
 * This provides a sensible starting point for the user. Also recalculates chunks and estimates
 * if data is already loaded.
 */
export function updateChunkSizeDefaults(): void {
    const currentState = state.getState();
    const selectedLevel = dom.errorCorrectionLevelSelect
        .value as ErrorCorrectionLevel;

    // Get capacity estimate and calculate a default chunk size with a buffer
    const qrCapacity = utils.getQrCapacityEstimate(selectedLevel);
    const defaultChunkSize = Math.max(
        config.MIN_CHUNK_SIZE, // Ensure minimum size
        qrCapacity - config.QR_CHUNK_SIZE_BUFFER // Subtract buffer from capacity
    );

    // Update the input field value
    dom.chunkSizeInput.value = defaultChunkSize.toString();
    console.log(
        `Default chunk size set to ${defaultChunkSize} for EC Level ${selectedLevel}`
    );

    // If data is already loaded, re-prepare chunks and update estimates immediately
    if (currentState.base64Data) {
        prepareChunks(); // This will call displayEstimates
    } else {
        displayEstimates(); // Update estimates even if no data (shows "Load file...")
    }
}

/**
 * Handles the file selection event from the file input.
 * Reads selected files, zips them, calculates checksum, encodes to base64,
 * and prepares the initial set of chunks.
 * @param event - The input change event.
 */
export async function handleFileSelect(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;

    // --- 1. Reset relevant sender state ---
    state.resetSenderStateInternal(true); // Full reset including file data
    clearQrInstance(); // Clear any old QR instance
    dom.senderEstimates.textContent = ""; // Clear old estimates
    dom.senderProgress.textContent = ""; // Clear old progress
    dom.startTransferBtn.disabled = true; // Disable button initially
    updateSenderStatus("Processing selection..."); // Initial status

    // --- 2. Handle empty selection ---
    if (!input.files || input.files.length === 0) {
        handleFileError("No file or folder selected.");
        // Clear the input visually (important for re-selecting the same file/folder)
        input.value = "";
        return;
    }

    // --- 3. Prepare file list and determine type ---
    const files = Array.from(input.files);
    // A single item that isn't part of a directory selection is a single file
    const isSingle = files.length === 1 && !files[0].webkitRelativePath;
    // If any file has a relative path, it's part of a folder selection
    const isFolder = files.some((f) => !!f.webkitRelativePath);

    let originalName = null;
    if (isSingle) {
        originalName = files[0].name;
    } else if (isFolder) {
        // Try to get the top-level folder name from the first file's path
        const firstPath = files[0].webkitRelativePath;
        originalName = firstPath ? firstPath.split("/")[0] : "folder"; // Fallback name
    }
    // Store file info in state
    state.setSenderFiles(files, isSingle, originalName);

    // Update status based on selection type
    if (isSingle) {
        updateSenderStatus(`Selected file: ${originalName}. Zipping...`);
    } else if (isFolder) {
        updateSenderStatus(
            `Selected folder: ${originalName} (${files.length} items). Zipping...`
        );
    } else {
        // Multiple files selected, but not via folder picker
        updateSenderStatus(`Selected ${files.length} files. Zipping...`);
    }
    dom.senderEstimates.textContent = "Processing zip...";
    state.setSenderPhase("processing"); // Indicate processing state

    // --- 4. Zip the files ---
    const zip = new JSZip();
    try {
        await Promise.all(
            files.map(async (file) => {
                const fileData = await file.arrayBuffer();
                // Use relative path for items within a folder, otherwise just the filename
                const pathInZip = file.webkitRelativePath || file.name;
                zip.file(pathInZip, fileData);
            })
        );

        updateSenderStatus(`Generating compressed ZIP...`);
        const zipBuffer = await zip.generateAsync({
            type: "arraybuffer",
            compression: "DEFLATE",
            compressionOptions: { level: 6 }, // Level 6 is a good balance
        });

        // --- 5. Calculate checksum and encode ---
        const checksum = utils.calculateChecksum(zipBuffer);
        const base64Zip = utils.arrayBufferToBase64(zipBuffer);

        // --- 6. Update state with processed data ---
        state.setSenderProcessedData(zipBuffer, base64Zip, checksum);
        state.setSenderPhase("ready"); // Set state to ready

        // --- 7. Update UI and prepare chunks ---
        const zipSizeKB = (zipBuffer.byteLength / 1024).toFixed(2);
        const fileCountMsg = isSingle ? "1 file" : `${files.length} items`;
        const selectionType = isFolder ? "folder" : isSingle ? "file" : "files";
        updateSenderStatus(
            `Ready: ${selectionType} (${fileCountMsg}), ZIP Size: ${zipSizeKB} KB.`,
            false
        );
        dom.startTransferBtn.disabled = false; // Enable start button
        prepareChunks(); // Prepare chunks and display initial estimates
    } catch (err) {
        handleFileError(
            `Error processing files: ${
                err instanceof Error ? err.message : String(err)
            }`
        );
        input.value = ""; // Clear input on error
        state.setSenderPhase("error"); // Set error state
    }
}

/**
 * Handles errors during file processing. Resets state and updates UI.
 * @param message - The error message to display.
 */
export function handleFileError(message: string): void {
    state.resetSenderStateInternal(true); // Full reset
    clearQrInstance();
    dom.startTransferBtn.disabled = true;
    updateSenderStatus(message, true);
    dom.senderEstimates.textContent = "";
    dom.senderProgress.textContent = "";
    state.setSenderPhase("error"); // Set state to error
}

/**
 * Calculates and splits the base64 encoded data into chunks suitable for QR codes.
 * Updates the sender state with the chunks and recalculates estimates.
 * @returns {boolean} True if chunks were prepared successfully, false otherwise.
 */
export function prepareChunks(): boolean {
    const currentState = state.getState();
    if (!currentState.base64Data || !currentState.dataToSendBuffer) {
        // Don't show error if no file is loaded yet, just clear estimates.
        if (currentState.filesToSend.length > 0) {
            // Only update status if file was loaded but processing failed somehow
            updateSenderStatus(
                "Error: No processed data available to chunk.",
                true
            );
        } else {
            updateSenderStatus("Select file/folder to begin.", false); // Guide user if no file selected
        }
        state.setSenderChunks([]); // Ensure chunks are empty
        displayEstimates(); // Update estimates (will show relevant message)
        return false;
    }

    const targetPayloadSize = parseInt(dom.chunkSizeInput.value, 10);
    if (isNaN(targetPayloadSize) || targetPayloadSize < config.MIN_CHUNK_SIZE) {
        updateSenderStatus(
            `Invalid Target Data size (min ${config.MIN_CHUNK_SIZE}).`,
            true
        );
        state.setSenderChunks([]);
        displayEstimates();
        // Don't enable start button if chunk size is invalid
        dom.startTransferBtn.disabled = true;
        return false;
    }

    const newChunks: string[] = [];
    const dataLength = currentState.base64Data.length;
    let startIndex = 0;
    const selectedLevel = dom.errorCorrectionLevelSelect
        .value as ErrorCorrectionLevel;
    const qrCapacity = utils.getQrCapacityEstimate(selectedLevel);

    // Estimate the metadata size for a typical 'data' chunk payload
    // Pass current file ID (even if empty initially, it's short)
    const metaSize = utils.estimateMetadataSize(
        "d",
        currentState.transferFileId || `fid_placeholder`
    );

    // Calculate the maximum data part of the payload we can fit
    // Subtract metadata size and an additional buffer
    const maxDataPayload = qrCapacity - metaSize - config.QR_CHUNK_SIZE_BUFFER;

    // Effective chunk size is the minimum of user target and calculated max, but not less than 1
    const effectiveChunkSize = Math.max(
        1, // Cannot be zero or negative
        Math.min(targetPayloadSize, maxDataPayload)
    );

    if (effectiveChunkSize <= 0 || maxDataPayload <= 0) {
        updateSenderStatus(
            `Chunk size too small for QR capacity/metadata (max data ~${maxDataPayload} bytes). Increase chunk size or lower EC level.`,
            true
        );
        state.setSenderChunks([]);
        displayEstimates();
        dom.startTransferBtn.disabled = true; // Disable start
        return false;
    }
    if (
        targetPayloadSize > maxDataPayload &&
        currentState.dataToSendBuffer.byteLength > 0
    ) {
        // Only warn if there's actual data
        console.warn(
            `Target chunk size (${targetPayloadSize}) exceeds estimated capacity (${maxDataPayload} data bytes). Using ${effectiveChunkSize}.`
        );
        // Optionally provide feedback to user here if desired
        // updateSenderStatus(`Warning: Target chunk size too large, using ${effectiveChunkSize}.`, false); // Example feedback
    }

    // Split the base64 data into chunks
    while (startIndex < dataLength) {
        const remainingLength = dataLength - startIndex;
        const currentChunkLength = Math.min(
            effectiveChunkSize,
            remainingLength
        );
        newChunks.push(
            currentState.base64Data.substring(
                startIndex,
                startIndex + currentChunkLength
            )
        );
        startIndex += currentChunkLength;
    }
    // Handle zero-byte file case: ensure one empty chunk if data length is 0
    if (dataLength === 0 && newChunks.length === 0) {
        // We need a handshake and final packet, but 0 data chunks.
        // state.setSenderChunks([]) is correct here. displayEstimates handles this.
    }

    // Update state with the newly created chunks
    state.setSenderChunks(newChunks); // Use setter
    console.log(
        `Data chunked into ${
            state.getState().totalDataChunks
        } chunk(s) with effective size <= ${effectiveChunkSize}`
    );

    // Update the estimates display based on the new chunk count
    displayEstimates();

    // Update status message to reflect readiness, enable start button
    // Allow 0 byte file (0 data chunks)
    if (state.getState().totalDataChunks >= 0) {
        const currentStatus = dom.senderStatus.textContent || "";
        // Avoid overwriting error messages related to chunk size calculation
        if (
            !currentStatus.startsWith("Error:") &&
            !currentStatus.startsWith("Warning:")
        ) {
            updateSenderStatus(
                `Ready to transfer ${
                    state.getState().totalDataChunks
                } data chunk(s).`,
                false
            );
        }
        dom.startTransferBtn.disabled = false; // Ensure start button is enabled if chunking is valid
        state.setSenderPhase("ready"); // Ensure state is ready
        return true;
    } else {
        // This case should ideally not be reached if validation is correct
        updateSenderStatus(`Error preparing chunks. Check settings.`, true);
        dom.startTransferBtn.disabled = true; // Disable if chunking failed
        state.setSenderPhase("error");
        return false;
    }
}

/**
 * Calculates and displays estimates for QR code count and transfer time.
 * Called whenever chunking is done or relevant inputs (delay, manual mode) change.
 */
export function displayEstimates(): void {
    const currentState = state.getState();

    // Only display estimates if data has been processed (even if 0 bytes)
    if (
        currentState.dataToSendBuffer !== null &&
        currentState.senderTransferPhase !== "processing"
    ) {
        const totalDataChunks = currentState.totalDataChunks; // Can be 0
        const handshakeQr = 1;
        const finalQr = 1;
        const totalQRCodes = handshakeQr + totalDataChunks + finalQr;

        // Calculate estimated time (only if not in manual mode)
        let timeString = "";
        // Use the *initial* manual mode checkbox setting for the main estimate display
        const isInitialManual = dom.manualModeCheckbox.checked;
        if (!isInitialManual) {
            const delayMs = parseInt(dom.delayInput.value, 10);
            // Use valid delay or default, ensuring it meets minimum
            const validDelay =
                !isNaN(delayMs) && delayMs >= config.MIN_DELAY_MS
                    ? delayMs
                    : config.DEFAULT_DELAY_MS;
            // Estimate time: total QRs * (delay per QR in seconds)
            // This is a lower bound, as it doesn't account for scan time.
            const estimatedSeconds = totalQRCodes * (validDelay / 1000);
            timeString = `, Est. Time: ${utils.formatTime(estimatedSeconds)}`;
        } else {
            timeString = ", Time: Manual (Initial)";
        }

        // Update the estimates display area
        dom.senderEstimates.textContent = `Data Chunks: ${totalDataChunks}, Total QRs: ${totalQRCodes}${timeString}`;
    } else if (currentState.senderTransferPhase === "processing") {
        dom.senderEstimates.textContent = "Processing zip...";
    } else {
        // Clear estimates if no file/data is loaded
        dom.senderEstimates.textContent =
            "Load a file/folder to see estimates.";
    }
    // Ensure progress text is cleared if we're not transferring
    if (
        currentState.senderTransferPhase === "idle" ||
        currentState.senderTransferPhase === "ready"
    ) {
        dom.senderProgress.textContent = "";
    }
}

/**
 * Starts the QR code transfer process.
 * Initializes state, generates a unique transfer ID, and displays the first QR code (handshake).
 */
export function startTransfer(): void {
    const currentState = state.getState();

    // --- 1. Pre-transfer Checks ---
    if (
        currentState.filesToSend.length === 0 ||
        currentState.dataToSendBuffer === null || // Check null explicitly
        currentState.base64Data === null // Should not be null if buffer exists, but check anyway
    ) {
        updateSenderStatus("No file processed or data is missing.", true);
        return;
    }
    // Double-check chunking is valid before starting
    if (!prepareChunks()) {
        updateSenderStatus(
            "Chunk preparation failed. Cannot start transfer.",
            true
        );
        return;
    }
    if (currentState.totalDataChunks < 0) {
        // Should not happen if prepareChunks is correct
        updateSenderStatus("Error: Invalid chunk count.", true);
        return;
    }

    // --- 2. Reset Transfer State Variables ---
    // Clear any existing timer
    if (currentState.transferTimer !== null)
        clearTimeout(currentState.transferTimer);
    state.setTransferTimer(null);

    // Generate a unique ID for this transfer session
    state.setTransferFileId(
        `fid_${Date.now()}_${Math.random().toString(16).substring(2, 8)}`
    );

    // Reset counters and indices for the main sequence
    state.setSenderPhase("transferring");
    state.setCurrentChunkIndex(-1); // Start before the first chunk (at handshake)
    state.setTotalStepsInCurrentSequence(currentState.totalDataChunks + 2); // Handshake + Data + Final
    state.setTransferStartTime(performance.now());
    state.setLastRateUpdateTime(state.getState().transferStartTime);
    state.setChunksSentSinceLastRateUpdate(0);
    state.setCurrentTransferRateBps(null);
    state.setSpecificChunksToSend([]); // Clear any previous specific send list
    state.setSpecificChunkSendIndex(0);

    // Set the manual mode flag for this sequence based on the INITIAL checkbox
    isCurrentSequenceManual = dom.manualModeCheckbox.checked;
    console.log(
        `Starting transfer. Initial manual mode: ${isCurrentSequenceManual}`
    );

    // --- 3. Update UI for Transfer Start ---
    updateSenderStatus("Initializing transfer...");
    dom.startTransferBtn.disabled = true;
    dom.fileInput.disabled = true;
    dom.errorCorrectionLevelSelect.disabled = true;
    dom.chunkSizeInput.disabled = true;
    dom.delayInput.disabled = true;
    dom.manualModeCheckbox.disabled = true; // Disable initial manual checkbox

    // Show QR modal
    dom.qrDisplayArea.classList.remove("hidden"); // Show QR area within modal
    dom.senderPostTransferOptions.classList.add("hidden"); // Hide post-transfer options
    dom.qrOverlay.classList.remove("hidden"); // Show the modal itself
    dom.qrCodeContainer.innerHTML = "<i>Generating Handshake QR...</i>"; // Placeholder
    dom.qrModalStatus.textContent = "Initializing...";
    dom.qrModalTimeEstimate.textContent = "";
    dom.qrModalTransferRate.textContent = "";
    dom.stopTransferBtn.textContent = "Stop Transfer"; // Set stop button text

    // --- 4. Start the QR Sequence ---
    if (isCurrentSequenceManual) {
        dom.nextChunkBtn.classList.remove("hidden");
        dom.nextChunkBtn.disabled = false; // Enable immediately for the first QR
        updateSenderStatus("Ready to display Handshake QR.");
    } else {
        dom.nextChunkBtn.classList.add("hidden");
        dom.nextChunkBtn.disabled = true;
        updateSenderStatus("Starting transfer sequence...");
    }
    displayNextChunk(); // Display the first (handshake) QR
}

/**
 * Updates the estimated transfer rate based on chunks sent over time.
 * @param chunkSizeBytes - The approximate size of the data chunk just processed (in bytes).
 */
function updateSenderRate(chunkSizeBytes: number): void {
    // Don't calculate rate if running in manual mode for the current sequence
    if (isCurrentSequenceManual) {
        state.setCurrentTransferRateBps(null); // Ensure rate is null
        return;
    }

    const currentState = state.getState();
    const now = performance.now();
    state.incrementChunksSentSinceRateUpdate();

    const timeSinceLastUpdate = now - currentState.lastRateUpdateTime;
    const chunksSinceLastUpdate = currentState.chunksSentSinceLastRateUpdate;

    // Update rate if enough time has passed OR enough chunks have been sent
    if (
        timeSinceLastUpdate > config.RATE_UPDATE_INTERVAL_MS ||
        chunksSinceLastUpdate >= config.RATE_UPDATE_MIN_CHUNKS
    ) {
        const timeDiffSeconds = timeSinceLastUpdate / 1000;
        // Estimate bytes sent based on the average size of the chunks processed since last update
        // Note: This assumes 'chunkSizeBytes' is representative, which is true for data chunks.
        const estimatedBytesSent = chunksSinceLastUpdate * chunkSizeBytes;

        // Calculate Bps, avoid division by zero or tiny intervals
        const newRateBps =
            timeDiffSeconds > 0.05
                ? estimatedBytesSent / timeDiffSeconds
                : null; // Avoid nonsensical rates for very short intervals

        state.setCurrentTransferRateBps(newRateBps);
        state.setLastRateUpdateTime(now);
        state.setChunksSentSinceLastRateUpdate(0); // Reset counter for next interval
    }
}

/**
 * Displays the next QR code in the sequence (Handshake, Data Chunk, or Final).
 * Handles scheduling the next QR display in automatic mode.
 */
export function displayNextChunk(): void {
    const currentState = state.getState();

    // --- 1. Guard Clauses ---
    if (currentState.senderTransferPhase !== "transferring") {
        console.warn(
            "displayNextChunk called outside of 'transferring' phase."
        );
        return;
    }
    if (
        currentState.dataToSendBuffer === null || // Check buffer presence
        currentState.base64Data === null // Check base64 string presence
        // No need to check totalDataChunks === null, as it's set in prepareChunks
    ) {
        handleFileError("Data error occurred during transfer."); // Use the error handler
        return;
    }

    // --- 2. Determine Payload Type and Content ---
    let payload: types.QRPayload | null = null;
    let mainStatus = ""; // Status message for UI
    let currentChunkSizeBytes = 0; // Size of data in current QR (for rate calc)

    const currentChunkDisplayIndex = currentState.currentChunkIndex + 1; // 0-based internal index -> 0=Handshake, 1..N=Data, N+1=Final
    const totalSteps = currentState.totalStepsInCurrentSequence; // Total QRs to display (Handshake + Data + Final)
    const stepNumber = currentChunkDisplayIndex + 1; // 1-based step number for display

    // --- Calculate Remaining Time (only if not manual) ---
    let remainingSeconds: number | null = null;
    if (!isCurrentSequenceManual && totalSteps > 0) {
        const delayMs = parseInt(dom.delayInput.value, 10);
        const validDelay =
            !isNaN(delayMs) && delayMs >= config.MIN_DELAY_MS
                ? delayMs
                : config.DEFAULT_DELAY_MS;
        const stepsRemaining = totalSteps - stepNumber;
        remainingSeconds = Math.max(0, stepsRemaining * (validDelay / 1000));
    }

    // --- Construct Payload based on current index ---
    if (currentChunkDisplayIndex === 0) {
        // Handshake (Index -1 -> Display Index 0)
        // ... (Payload construction remains the same)
        const handshakeBase: Omit<types.QRHandshakePayload, "ofn"> = {
            v: config.PROTOCOL_VERSION,
            fid: currentState.transferFileId,
            typ: "h",
            nam: encodeURIComponent(config.MULTI_FILE_ARCHIVE_NAME), // Always send archive name
            siz: currentState.dataToSendBuffer!.byteLength, // Use non-null assertion
            tot: currentState.totalDataChunks,
            zip: true, // Always true as we zip everything
        };
        // Add original filename if it was a single file originally
        payload =
            currentState.isSingleFileOriginal &&
            currentState.originalSingleFilename
                ? {
                    ...handshakeBase,
                    ofn: encodeURIComponent(
                        currentState.originalSingleFilename
                    ),
                }
                : handshakeBase;
        mainStatus = `Displaying Handshake [${stepNumber}/${totalSteps}]`;
    } else if (currentChunkDisplayIndex <= currentState.totalDataChunks) {
        // Data Chunk (Index 0..N-1 -> Display Index 1..N)
        // ... (Payload construction remains the same)
        const dataChunkIndex = currentChunkDisplayIndex - 1; // 0-based index into chunks array
        if (
            dataChunkIndex < 0 ||
            dataChunkIndex >= currentState.chunks.length
        ) {
            handleFileError(
                `Internal Error: Invalid data chunk index ${dataChunkIndex}.`
            );
            return;
        }
        payload = {
            v: config.PROTOCOL_VERSION,
            fid: currentState.transferFileId,
            typ: "d",
            seq: dataChunkIndex + 1, // Sequence number is 1-based
            dat: currentState.chunks[dataChunkIndex],
        };
        currentChunkSizeBytes = Math.ceil(payload.dat.length * 0.75); // Estimate byte size from base64
        mainStatus = `Displaying Chunk ${payload.seq}/${currentState.totalDataChunks} [${stepNumber}/${totalSteps}]`;
    } else if (currentChunkDisplayIndex === currentState.totalDataChunks + 1) {
        // Final QR (Index N -> Display Index N+1)
        // ... (Payload construction remains the same)
        if (!currentState.dataToSendChecksum) {
            handleFileError(
                `Internal Error: Missing checksum for final packet.`
            );
            return;
        }
        payload = {
            v: config.PROTOCOL_VERSION,
            fid: currentState.transferFileId,
            typ: "f",
            chk: currentState.dataToSendChecksum,
        };
        mainStatus = `Displaying Final Confirmation [${stepNumber}/${totalSteps}]`;
    } else {
        // Should not be reached if logic is correct
        console.error(
            "Invalid index reached in displayNextChunk:",
            currentChunkDisplayIndex
        );
        state.setSenderPhase("post_final"); // Transition to post-final state
        handlePostFinalState(); // Show options immediately
        return;
    }

    // --- 3. Generate and Display QR Code ---
    const payloadString = JSON.stringify(payload);
    dom.senderProgress.textContent = mainStatus; // Update progress text in main view

    // Update transfer rate (only for data chunks in auto mode)
    if (payload.typ === "d" && !isCurrentSequenceManual) {
        updateSenderRate(currentChunkSizeBytes);
    }

    // Update status display (main view and modal)
    updateSenderStatus(
        mainStatus,
        false, // Not an error
        remainingSeconds,
        state.getState().currentTransferRateBps // Pass current rate
    );

    // Check payload size against capacity estimate (sanity check)
    const qrCapacity = utils.getQrCapacityEstimate(
        dom.errorCorrectionLevelSelect.value as ErrorCorrectionLevel
    );
    if (payloadString.length > qrCapacity * 1.1) {
        // Allow slight exceeding due to estimate nature
        // If payload is significantly larger than estimate, it's likely an error
        updateSenderStatus(
            `ERROR: Payload size (${payloadString.length}) may exceed QR capacity (~${qrCapacity}). Try increasing chunk size target or lowering EC level.`,
            true
        );
        state.resetSenderStateInternal(false); // Reset transfer, keep files
        // Update UI to reflect stop
        handleStopTransfer(false); // Call stop handler without full reset
        return;
    } else if (payloadString.length > qrCapacity) {
        console.warn(
            `Payload size (${payloadString.length}) slightly exceeds estimate (~${qrCapacity}). QR generation might fail or be unreadable.`
        );
    }

    // Generate or update the QR code visually
    generateOrUpdateQrCode(payloadString);

    // --- 4. Advance State and Schedule Next Step ---
    state.setCurrentChunkIndex(currentState.currentChunkIndex + 1); // Move to the next internal index
    const nextInternalIndex = state.getState().currentChunkIndex;

    // Check if this was the last QR code in the main sequence (the Final QR)
    if (nextInternalIndex >= currentState.totalDataChunks + 1) {
        // Index N or greater means Final was just displayed
        state.setSenderPhase("final_qr_displayed"); // Mark that the final QR is up

        if (isCurrentSequenceManual) {
            // In manual mode, enable the button to proceed to options
            dom.nextChunkBtn.disabled = false;
            dom.nextChunkBtn.textContent = `Show Resend Options`; // Update button text
            updateSenderStatus(
                "Final QR displayed. Click button for options.",
                false,
                null,
                null
            ); // Clear rate/time
        } else {
            // In automatic mode, schedule transition to post-final state after a delay
            if (state.getState().transferTimer !== null)
                clearTimeout(state.getState().transferTimer!);
            const delay = parseInt(dom.delayInput.value, 10);
            state.setTransferTimer(
                window.setTimeout(
                    handlePostFinalState,
                    Math.max(config.DEFAULT_DELAY_MS, delay)
                ) // Use default delay as minimum time to show final QR
            );
            updateSenderStatus(
                "Final QR displayed. Waiting for receiver check...",
                false,
                0,
                null
            ); // Show 0 time remaining
        }
    } else {
        // Still more QRs (Handshake or Data) to display
        if (isCurrentSequenceManual) {
            // In manual mode, enable the button for the *next* QR
            dom.nextChunkBtn.disabled = false;
            const nextStepNumber = nextInternalIndex + 2; // Calculate next step number (1-based)
            dom.nextChunkBtn.textContent = `Next QR [${nextStepNumber}/${totalSteps}]`;
        } else {
            // In automatic mode, schedule the *next* QR display after a delay
            if (state.getState().transferTimer !== null)
                clearTimeout(state.getState().transferTimer!);
            const delay = parseInt(dom.delayInput.value, 10);
            state.setTransferTimer(
                window.setTimeout(
                    displayNextChunk,
                    Math.max(config.MIN_DELAY_MS, delay)
                ) // Use configured delay
            );
        }
    }
}

/**
 * Transitions the sender UI to the "post-final" state after the initial sequence
 * (or the final QR in manual mode) has been displayed. Shows options for resending.
 */
export function handlePostFinalState(): void {
    const currentTimer = state.getState().transferTimer;
    if (currentTimer) clearTimeout(currentTimer);
    state.setTransferTimer(null);

    // Only proceed if we were in a relevant phase
    if (
        !["transferring", "sending_specific", "final_qr_displayed"].includes(
            state.getState().senderTransferPhase
        )
    ) {
        console.log(
            "handlePostFinalState called from unexpected phase:",
            state.getState().senderTransferPhase
        );
        return;
    }

    state.setSenderPhase("post_final"); // Update the state
    console.log("Transitioning to post_final state");

    // --- Update UI elements for the post-transfer options ---
    updateSenderStatus(
        "Transfer sequence complete. Check receiver status for missing chunks.",
        false,
        null,
        null
    );
    dom.qrDisplayArea.classList.add("hidden"); // Hide the QR code itself
    dom.senderPostTransferOptions.classList.remove("hidden"); // Show the resend options
    dom.stopTransferBtn.textContent = "Finish & Close"; // Change stop button text
    dom.qrModalTimeEstimate.textContent = ""; // Clear time estimate
    dom.qrModalTransferRate.textContent = ""; // Clear transfer rate
    dom.qrModalStatus.textContent = "Sequence Complete"; // Update modal status
    dom.specificChunksInput.value = ""; // Clear specific chunk input
    dom.sendSpecificStatus.textContent = ""; // Clear specific send status

    // **** ADDED: Reset the resend manual mode checkbox ****
    dom.resendManualModeCheckbox.checked = false;

    // Hide the 'Next' button if it was visible
    dom.nextChunkBtn.classList.add("hidden");
    dom.nextChunkBtn.disabled = true;

    // Reset the sequence manual flag
    isCurrentSequenceManual = false;
}

/**
 * Handles the "Send All Again" button click. Restarts the entire transfer sequence
 * from the handshake QR code. Uses the 'resendManualModeCheckbox' to determine mode.
 */
export function handleSendAllAgain(): void {
    const currentState = state.getState();
    if (!currentState.dataToSendBuffer || !currentState.base64Data) {
        updateSenderStatus("Cannot resend: No data loaded.", true);
        return;
    }

    // --- 1. Reset Transfer State (Similar to startTransfer) ---
    if (currentState.transferTimer !== null)
        clearTimeout(currentState.transferTimer);
    state.setTransferTimer(null);
    // Keep the existing transferFileId

    // Reset counters and indices
    state.setSenderPhase("transferring"); // Go back to transferring state
    state.setCurrentChunkIndex(-1); // Start before the first chunk (at handshake)
    state.setTotalStepsInCurrentSequence(currentState.totalDataChunks + 2); // Handshake + Data + Final
    state.setTransferStartTime(performance.now());
    state.setLastRateUpdateTime(state.getState().transferStartTime);
    state.setChunksSentSinceLastRateUpdate(0);
    state.setCurrentTransferRateBps(null);
    state.setSpecificChunksToSend([]); // Clear specific send list
    state.setSpecificChunkSendIndex(0);

    // **** ADDED: Set manual mode for this sequence based on RESEND checkbox ****
    isCurrentSequenceManual = dom.resendManualModeCheckbox.checked;
    console.log(
        `Resending all. Manual mode for this sequence: ${isCurrentSequenceManual}`
    );

    // --- 2. Update UI for Resend Start ---
    updateSenderStatus("Restarting transfer sequence...");
    dom.senderPostTransferOptions.classList.add("hidden"); // Hide options
    dom.qrDisplayArea.classList.remove("hidden"); // Show QR area
    dom.stopTransferBtn.textContent = "Stop Transfer"; // Reset stop button text
    dom.qrCodeContainer.innerHTML = "<i>Generating Handshake QR...</i>"; // Placeholder
    dom.qrModalTimeEstimate.textContent = "";
    dom.qrModalTransferRate.textContent = "";

    // --- 3. Start the QR Sequence Again ---
    if (isCurrentSequenceManual) {
        dom.nextChunkBtn.classList.remove("hidden");
        dom.nextChunkBtn.disabled = false; // Enable immediately
        updateSenderStatus("Ready to display Handshake QR (Resend).");
    } else {
        dom.nextChunkBtn.classList.add("hidden");
        dom.nextChunkBtn.disabled = true;
        updateSenderStatus("Resending transfer sequence...");
    }
    displayNextChunk(); // Display first QR, subsequent logic handles mode
}

/**
 * Handles the "Send Specific" button click. Parses the user's input for chunk numbers
 * and starts a sequence to display only those specific data chunks. Uses the
 * 'resendManualModeCheckbox' to determine mode.
 */
export function handleSendSpecific(): void {
    const currentState = state.getState();
    if (!currentState.dataToSendBuffer || currentState.chunks.length === 0) {
        updateSenderStatus(
            "Cannot send specific chunks: No data/chunks loaded.",
            true
        );
        dom.sendSpecificStatus.textContent = "Error: No data loaded.";
        return;
    }

    const input = dom.specificChunksInput.value;
    dom.sendSpecificStatus.textContent = ""; // Clear previous status

    // --- 1. Parse Chunk Input ---
    const parsedChunks = utils.parseChunkInput(
        input,
        currentState.totalDataChunks // Pass the maximum valid chunk number
    );

    if (parsedChunks === null) {
        dom.sendSpecificStatus.textContent =
            "Invalid input format. Use numbers, commas, and hyphens (e.g., 1,3,5-8).";
        return;
    }
    if (parsedChunks.length === 0) {
        dom.sendSpecificStatus.textContent =
            "No valid chunk numbers specified.";
        return;
    }

    // --- 2. Reset Specific Send State ---
    if (currentState.transferTimer !== null)
        clearTimeout(currentState.transferTimer);
    state.setTransferTimer(null);
    // Keep the existing transferFileId

    state.setSpecificChunksToSend(parsedChunks); // Store the list of chunks to send
    state.setSpecificChunkSendIndex(0); // Start at the beginning of the list
    state.setSenderPhase("sending_specific"); // Set the correct phase
    state.setTotalStepsInCurrentSequence(parsedChunks.length); // Total steps = number of specific chunks
    state.setTransferStartTime(performance.now()); // Reset timer for rate calculation
    state.setLastRateUpdateTime(state.getState().transferStartTime);
    state.setChunksSentSinceLastRateUpdate(0);
    state.setCurrentTransferRateBps(null);

    // **** ADDED: Set manual mode for this sequence based on RESEND checkbox ****
    isCurrentSequenceManual = dom.resendManualModeCheckbox.checked;
    console.log(
        `Sending specific chunks. Manual mode for this sequence: ${isCurrentSequenceManual}`
    );

    // --- 3. Update UI for Specific Send ---
    updateSenderStatus(
        `Preparing to send ${parsedChunks.length} specific chunk(s)...`
    );
    dom.senderPostTransferOptions.classList.add("hidden"); // Hide options
    dom.qrDisplayArea.classList.remove("hidden"); // Show QR area
    dom.stopTransferBtn.textContent = "Stop Specific Send"; // Update stop button
    dom.qrCodeContainer.innerHTML = "<i>Generating QR...</i>"; // Placeholder
    dom.qrModalTimeEstimate.textContent = "";
    dom.qrModalTransferRate.textContent = "";
    dom.sendSpecificStatus.textContent = `Sending chunks: ${parsedChunks.join(
        ", "
    )}`;

    // --- 4. Start Displaying Specific Chunks ---
    if (isCurrentSequenceManual) {
        dom.nextChunkBtn.classList.remove("hidden");
        dom.nextChunkBtn.disabled = false; // Enable button for the first specific chunk
    } else {
        dom.nextChunkBtn.classList.add("hidden");
        dom.nextChunkBtn.disabled = true;
    }
    displaySpecificChunk(); // Show the first one, subsequent logic handles mode
}

/**
 * Displays the next specific chunk from the `specificChunksToSend` list.
 * Handles scheduling based on the `isCurrentSequenceManual` flag.
 */
export function displaySpecificChunk(): void {
    const currentState = state.getState();

    // --- 1. Guard Clauses ---
    if (currentState.senderTransferPhase !== "sending_specific") {
        console.warn(
            "displaySpecificChunk called outside of 'sending_specific' phase."
        );
        return;
    }
    // Check if we've finished sending all requested specific chunks
    if (
        currentState.specificChunkSendIndex >=
        currentState.specificChunksToSend.length
    ) {
        // Finished the list
        updateSenderStatus(
            "Specific chunk send complete. Displaying final confirmation QR...",
            false,
            null,
            null
        );
        // Don't change isCurrentSequenceManual here, let displayFinalConfirmationQR handle it
        displayFinalConfirmationQR(); // Show the final 'f' packet again
        return;
    }

    if (!currentState.dataToSendBuffer || currentState.chunks.length === 0) {
        handleFileError("Data error occurred during specific send.");
        return;
    }

    // --- 2. Get Chunk Info ---
    const currentSpecificIndex = currentState.specificChunkSendIndex; // Index in the specificChunksToSend array
    const chunkSequenceNumber =
        currentState.specificChunksToSend[currentSpecificIndex]; // The actual chunk number (1-based)
    const chunkArrayIndex = chunkSequenceNumber - 1; // 0-based index for the main chunks array

    // Validate the chunk index derived from the sequence number
    if (chunkArrayIndex < 0 || chunkArrayIndex >= currentState.chunks.length) {
        const errorMsg = `Error: Invalid chunk number ${chunkSequenceNumber} requested. Skipping.`;
        updateSenderStatus(errorMsg, true);
        dom.sendSpecificStatus.textContent = errorMsg; // Show error in specific status too
        // Skip this invalid chunk and move to the next one
        state.setSpecificChunkSendIndex(currentSpecificIndex + 1);
        scheduleNextSpecificChunk(); // Try to display the next one
        return;
    }

    // --- 3. Construct Payload ---
    const payload: types.QRDataPayload = {
        v: config.PROTOCOL_VERSION,
        fid: currentState.transferFileId,
        typ: "d",
        seq: chunkSequenceNumber, // Use the 1-based sequence number
        dat: currentState.chunks[chunkArrayIndex],
    };
    const payloadString = JSON.stringify(payload);
    const currentChunkSizeBytes = Math.ceil(payload.dat.length * 0.75); // Approx size

    // --- 4. Update UI ---
    const totalSpecific = currentState.totalStepsInCurrentSequence; // Total specific chunks requested
    const currentStepNumber = currentSpecificIndex + 1; // 1-based step number within the specific sequence
    const mainStatus = `Resending Chunk ${chunkSequenceNumber} [${currentStepNumber}/${totalSpecific}]`;

    // Calculate remaining time estimate (only if not manual)
    let remainingSeconds: number | null = null;
    if (!isCurrentSequenceManual && totalSpecific > 0) {
        const delayMs = parseInt(dom.delayInput.value, 10);
        const validDelay =
            !isNaN(delayMs) && delayMs >= config.MIN_DELAY_MS
                ? delayMs
                : config.DEFAULT_DELAY_MS;
        const stepsRemaining = totalSpecific - currentStepNumber;
        remainingSeconds = Math.max(0, stepsRemaining * (validDelay / 1000));
    }

    dom.senderProgress.textContent = mainStatus; // Update progress in main view

    // Update transfer rate (only in auto mode)
    if (!isCurrentSequenceManual) {
        updateSenderRate(currentChunkSizeBytes);
    }

    // Update status (main view and modal)
    updateSenderStatus(
        mainStatus,
        false,
        remainingSeconds,
        state.getState().currentTransferRateBps
    );

    // Check payload size (sanity check)
    const qrCapacity = utils.getQrCapacityEstimate(
        dom.errorCorrectionLevelSelect.value as ErrorCorrectionLevel
    );
    if (payloadString.length > qrCapacity * 1.1) {
        updateSenderStatus(
            `ERROR: Specific chunk ${chunkSequenceNumber} payload too large!`,
            true
        );
        // Go back to post-final options state on error
        state.setSenderPhase("post_final");
        handlePostFinalState(); // This resets isCurrentSequenceManual = false
        return;
    } else if (payloadString.length > qrCapacity) {
        console.warn(
            `Specific chunk ${chunkSequenceNumber} payload size (${payloadString.length}) slightly exceeds estimate (~${qrCapacity}).`
        );
    }

    // --- 5. Generate QR ---
    generateOrUpdateQrCode(payloadString);

    // --- 6. Advance State and Schedule ---
    state.setSpecificChunkSendIndex(currentSpecificIndex + 1); // Move to next specific chunk index
    scheduleNextSpecificChunk(); // Schedule the display of the *next* specific chunk
}

/**
 * Schedules the display of the next specific chunk or the final confirmation QR.
 * Handles both manual and automatic modes based on `isCurrentSequenceManual`.
 */
function scheduleNextSpecificChunk(): void {
    const currentState = state.getState();
    if (currentState.senderTransferPhase !== "sending_specific") return; // Only relevant in this phase

    const nextSpecificIndex = currentState.specificChunkSendIndex;
    const totalSpecific = currentState.totalStepsInCurrentSequence;

    // Check if there are more specific chunks left in the list
    if (nextSpecificIndex < currentState.specificChunksToSend.length) {
        // More specific chunks to send
        if (isCurrentSequenceManual) {
            // Enable button for the next specific chunk
            dom.nextChunkBtn.disabled = false;
            dom.nextChunkBtn.textContent = `Next Specific [${
                nextSpecificIndex + 1
            }/${totalSpecific}]`;
        } else {
            // Schedule the next specific chunk display automatically
            if (state.getState().transferTimer !== null)
                clearTimeout(state.getState().transferTimer!);
            const delay = parseInt(dom.delayInput.value, 10);
            state.setTransferTimer(
                window.setTimeout(
                    displaySpecificChunk,
                    Math.max(config.MIN_DELAY_MS, delay)
                )
            );
        }
    } else {
        // All specified chunks have been displayed
        updateSenderStatus(
            "Finished sending specific chunk batch. Displaying final confirm QR...",
            false,
            null,
            null
        );
        // Don't change phase here, let displayFinalConfirmationQR handle it.
        if (isCurrentSequenceManual) {
            // Enable button to show the final confirmation QR
            dom.nextChunkBtn.textContent = "Show Final QR";
            dom.nextChunkBtn.disabled = false;
            // Don't call displayFinalConfirmationQR directly, let the button click handle it
        } else {
            // Schedule the display of the final confirmation QR automatically
            if (state.getState().transferTimer !== null)
                clearTimeout(state.getState().transferTimer!);
            const delay = parseInt(dom.delayInput.value, 10);
            // Add a slightly longer delay before showing the final QR after a specific send
            state.setTransferTimer(
                window.setTimeout(
                    displayFinalConfirmationQR,
                    Math.max(config.DEFAULT_DELAY_MS / 2, delay)
                )
            );
        }
    }
}

/**
 * Displays the final confirmation QR code (type 'f') containing the checksum.
 * This is shown after the main sequence, or after a specific send sequence.
 * Handles manual/auto mode transition to post-final options.
 */
export function displayFinalConfirmationQR(): void {
    const currentState = state.getState();

    // --- 1. Guard Clauses ---
    if (!currentState.dataToSendBuffer || !currentState.dataToSendChecksum) {
        handleFileError("Cannot display final QR: data or checksum missing.");
        return;
    }
    // Can be called after 'transferring' (main sequence end) or 'sending_specific' (specific sequence end)
    if (
        !["transferring", "sending_specific", "final_qr_displayed"].includes(
            currentState.senderTransferPhase
        )
    ) {
        console.warn(
            "displayFinalConfirmationQR called from unexpected phase:",
            currentState.senderTransferPhase
        );
    }
    state.setSenderPhase("final_qr_displayed"); // Ensure phase is correct

    // --- 2. Construct Payload ---
    const payload: types.QRFinalPayload = {
        v: config.PROTOCOL_VERSION,
        fid: currentState.transferFileId,
        typ: "f",
        chk: currentState.dataToSendChecksum,
    };
    const payloadString = JSON.stringify(payload);

    // --- 3. Update UI ---
    const mainStatus = `Displaying Final Confirmation QR`;
    dom.senderProgress.textContent = mainStatus; // Update main view progress
    updateSenderStatus(mainStatus, false, null, null); // Update status (no rate/time)

    // Check payload size (sanity check)
    const qrCapacity = utils.getQrCapacityEstimate(
        dom.errorCorrectionLevelSelect.value as ErrorCorrectionLevel
    );
    if (payloadString.length > qrCapacity * 1.1) {
        updateSenderStatus(
            `ERROR: Final confirmation payload too large!`,
            true
        );
        state.resetSenderStateInternal(false); // Reset transfer, keep files
        handleStopTransfer(false); // Update UI to stopped state
        return;
    } else if (payloadString.length > qrCapacity) {
        console.warn(
            `Final confirmation payload size (${payloadString.length}) slightly exceeds estimate (~${qrCapacity}).`
        );
    }

    // --- 4. Generate QR ---
    generateOrUpdateQrCode(payloadString);

    // --- 5. Schedule Next Step (Transition to post-final options) ---
    if (isCurrentSequenceManual) {
        // In manual mode, enable the button to show the resend options
        dom.nextChunkBtn.textContent = "Show Resend Options";
        dom.nextChunkBtn.disabled = false;
        dom.nextChunkBtn.classList.remove("hidden"); // Ensure visible
    } else {
        // In automatic mode, schedule the transition to the post-final state
        if (state.getState().transferTimer !== null)
            clearTimeout(state.getState().transferTimer!);
        const delay = parseInt(dom.delayInput.value, 10);
        // Use a standard delay to allow receiver to scan final QR
        state.setTransferTimer(
            window.setTimeout(
                handlePostFinalState,
                Math.max(config.DEFAULT_DELAY_MS, delay)
            )
        );
    }
}

/**
 * Generates a new QR code or updates the existing one with new data.
 * Uses the qr-code-styling library and appends to the dedicated container.
 * @param data - The string data to encode in the QR code.
 */
function generateOrUpdateQrCode(data: string): void {
    // --- 1. Define QR Code Options ---
    // Use a large base size; CSS will scale it down via max-width/max-height.
    // This provides high resolution for the QR code image.
    const baseSize = 2000;
    const options: QRCodeStylingOptions = {
        width: baseSize,
        height: baseSize,
        data: data, // The actual data (JSON string) to encode
        margin: 10, // Small margin around the QR code
        shape: "square", // Shape of the QR modules (dots)
        qrOptions: {
            typeNumber: 0, // Auto-detect QR version (size) based on data length
            mode: "Byte", // Encoding mode, suitable for arbitrary binary/string data
            errorCorrectionLevel: dom.errorCorrectionLevelSelect
                .value as ErrorCorrectionLevel, // Get level from UI
        },
        dotsOptions: {
            type: "square", // Style of the dots (can be 'dots', 'rounded', etc.)
            // color: "#000000" // Default: black
        },
        backgroundOptions: {
            color: "#ffffff", // Default: white
        },
        // imageOptions: { // Example: embedding an image
        //     src: "/vite.svg",
        //     margin: 4,
        //     imageSize: 0.3 // Relative size
        // }
    };

    // --- 2. Get Target DOM Element ---
    const targetElement = dom.qrCodeContainer;
    if (!targetElement) {
        console.error("QR Code container element not found in DOM.");
        updateSenderStatus("UI Error: QR container missing", true);
        return;
    }

    // --- 3. Generate or Update QR Code ---
    try {
        if (!qrCodeInstance) {
            // If no instance exists, create a new one and append it
            targetElement.innerHTML = ""; // Clear placeholder/previous error
            qrCodeInstance = new QRCodeStyling(options);
            qrCodeInstance.append(targetElement);
            console.log("Created new QR code instance.");
        } else {
            // If instance exists, update it with new data/options
            // Check if the QR code is still attached to the DOM (it might be removed if modal closes unexpectedly)
            // Use optional chaining for safety, although _canvas / _svg might not be directly accessible depending on version
            // @ts-ignore
            const canvasElement = qrCodeInstance?._canvas;
            const svgElement = qrCodeInstance?._svg;

            if (
                !(canvasElement && targetElement.contains(canvasElement)) &&
                !(svgElement && targetElement.contains(svgElement))
            ) {
                console.warn(
                    "QR code instance found, but not attached to target element. Re-appending."
                );
                targetElement.innerHTML = ""; // Clear container first
                // Re-append might require re-creating or specific library method if available
                // For qr-code-styling, re-appending might be complex. Let's try update first, then recreate if update fails.
                try {
                    qrCodeInstance.update(options); // Try updating anyway
                } catch (updateError) {
                    console.warn(
                        "Update failed after re-append check, re-creating QR instance.",
                        updateError
                    );
                    targetElement.innerHTML = "";
                    qrCodeInstance = new QRCodeStyling(options);
                    qrCodeInstance.append(targetElement);
                }
            } else {
                // Standard update
                qrCodeInstance.update(options);
            }
            // console.log("Updated existing QR code instance."); // Reduce console noise
        }
    } catch (error) {
        console.error("Error generating or updating QR code:", error);
        updateSenderStatus(
            `QR Generation Error: ${
                error instanceof Error ? error.message : "Unknown"
            }`,
            true
        );
        targetElement.innerHTML = "<i>QR Error</i>"; // Display error in container
        // Consider stopping the transfer here if QR generation fails critically
        handleStopTransfer(false);
    }
}

/**
 * Stops the current transfer process and resets the sender UI to a state
 * where a new transfer can be started or files can be re-selected.
 * @param fullReset - If true, also clears selected files and processed data. If false, keeps files loaded.
 */
export function handleStopTransfer(fullReset: boolean = true): void {
    console.log(`Stopping transfer. Full reset: ${fullReset}`);
    const currentState = state.getState();
    const wasScanningPhase = [
        "transferring",
        "sending_specific",
        "final_qr_displayed",
    ].includes(currentState.senderTransferPhase);

    // 1. Clear timers and reset internal state
    if (currentState.transferTimer !== null) {
        clearTimeout(currentState.transferTimer);
    }
    state.resetSenderStateInternal(fullReset); // Reset core state variables
    clearQrInstance(); // Dispose of QR code instance
    isCurrentSequenceManual = false; // Reset manual mode flag

    // 2. Update UI Elements to reflect the stopped/reset state
    updateSenderStatus(
        fullReset
            ? "Transfer stopped. Ready for new file/folder."
            : "Transfer stopped. File still loaded.",
        false
    ); // Use non-error status
    dom.senderProgress.textContent = "";
    dom.senderEstimates.textContent = fullReset
        ? "Load a file/folder to see estimates."
        : currentState.dataToSendBuffer
        ? dom.senderEstimates.textContent
        : "Load a file/folder..."; // Show estimates if file kept
    dom.senderTransferRate.textContent = "";

    // Hide modal only if it was actively showing QR codes
    if (
        wasScanningPhase ||
        dom.qrOverlay.classList.contains("hidden") === false
    ) {
        dom.qrOverlay.classList.add("hidden"); // Hide the modal
    }
    dom.qrCodeContainer.innerHTML = ""; // Clear QR display area
    dom.qrModalStatus.textContent = "";
    dom.qrModalTimeEstimate.textContent = "";
    dom.qrModalTransferRate.textContent = "";
    dom.senderPostTransferOptions.classList.add("hidden"); // Hide resend options

    // Reset inputs and buttons
    if (fullReset) {
        dom.fileInput.value = ""; // Clear file input visually
    }
    // Enable controls again
    dom.startTransferBtn.disabled = !(
        state.getState().filesToSend.length > 0 &&
        state.getState().dataToSendBuffer
    ); // Re-enable start button ONLY if data is still validly loaded (i.e., !fullReset and data exists)
    dom.fileInput.disabled = false;
    dom.errorCorrectionLevelSelect.disabled = false;
    dom.chunkSizeInput.disabled = false;
    dom.delayInput.disabled = false;
    dom.manualModeCheckbox.disabled = false; // Re-enable initial manual checkbox

    // Reset manual mode button
    dom.nextChunkBtn.classList.add("hidden");
    dom.nextChunkBtn.disabled = true;
    dom.nextChunkBtn.textContent = "Next QR";
    dom.stopTransferBtn.textContent = "Stop Transfer"; // Reset stop button text

    // Recalculate estimates if data is still loaded
    if (!fullReset && state.getState().dataToSendBuffer) {
        displayEstimates();
    }
}

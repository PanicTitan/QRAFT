/**
 * @file state.ts
 * Manages the application's state using module-level variables.
 * Exports getter functions to access the state and setter functions
 * or specific action functions (like addReceivedChunk) to modify it.
 * This promotes controlled state updates. Also includes internal reset functions.
 */

import QrScanner from "qr-scanner"; // Type needed for qrScanner instance
import { SenderPhase, ReceiverState } from "./types"; // Import state type definitions

// --- State Variables (Private within the module) ---

// --- Sender State ---
let filesToSend: File[] = []; // Array of selected File objects
let isSingleFileOriginal: boolean = false; // Was the selection a single file (not folder)?
let originalSingleFilename: string | null = null; // Name of the single file if applicable
let dataToSendBuffer: ArrayBuffer | null = null; // Zipped data as ArrayBuffer
let base64Data: string = ""; // Zipped data encoded as Base64 string
let chunks: string[] = []; // Array of Base64 data chunks
let currentChunkIndex: number = -1; // 0-based index of the *next* chunk to be processed/displayed (-1 means handshake is next)
let totalDataChunks: number = 0; // Total number of data chunks ('d' type) generated
let transferFileId: string = ""; // Unique ID for the current transfer session
let transferTimer: number | null = null; // Timer ID for automatic QR sequencing (setTimeout)
let dataToSendChecksum: string = ""; // Checksum of the dataToSendBuffer
let senderTransferPhase: SenderPhase = "idle"; // Current phase of the sender state machine
let specificChunksToSend: number[] = []; // List of specific chunk sequence numbers (1-based) to resend
let specificChunkSendIndex: number = 0; // Index into the specificChunksToSend array
// Rate Calculation (Sender)
let transferStartTime: number = 0; // Timestamp when transfer started (performance.now())
let totalStepsInCurrentSequence: number = 0; // Total QRs in the current sequence (main or specific)
let lastRateUpdateTime: number = 0; // Timestamp of the last rate calculation
let chunksSentSinceLastRateUpdate: number = 0; // Counter for chunks sent since last rate update
let currentTransferRateBps: number | null = null; // Estimated sender transfer rate in Bytes/sec

// --- Receiver State ---
let qrScanner: QrScanner | null = null; // Instance of the QrScanner library
let isScanning: boolean = false; // Is the receiver camera actively scanning?
let expectedFileId: string | null = null; // File ID expected from the current transfer handshake
let expectedTotalChunks: number | null = null; // Total data chunks expected for the current transfer
let expectedArchiveName: string | null = null; // Filename of the archive expected
let expectedDataSize: number | null = null; // Total size (in bytes) of the zipped data expected
let expectedIsZip: boolean = false; // Is the received data expected to be a zip file? (always true now)
let expectedOriginalFilename: string | null = null; // Original filename if it was a single file transfer
let receivedChunksMap = new Map<number, string>(); // Map storing received chunks (SeqNum -> Base64Data)
let receivedChunkCount: number = 0; // Count of unique chunks received
let receiverState: ReceiverState = "idle"; // Current state of the receiver state machine
// Rate Calculation (Receiver)
let receiverStartTime: number = 0; // Timestamp when receiver started processing this transfer
let receiverLastRateUpdateTime: number = 0; // Timestamp of the last rate calculation
let receiverBytesSinceLastUpdate: number = 0; // Bytes accumulated since last rate update
let receiverCurrentRateBps: number | null = null; // Estimated receiver transfer rate in Bytes/sec

// --- State Access (Getter) ---

/**
 * Gets a snapshot of the current application state.
 * @returns An object containing all current state variables.
 */
export const getState = () => ({
    // Sender State Snapshot
    filesToSend,
    isSingleFileOriginal,
    originalSingleFilename,
    dataToSendBuffer,
    base64Data,
    chunks,
    currentChunkIndex,
    totalDataChunks,
    transferFileId,
    transferTimer,
    dataToSendChecksum,
    senderTransferPhase,
    specificChunksToSend,
    specificChunkSendIndex,
    transferStartTime,
    totalStepsInCurrentSequence,
    lastRateUpdateTime,
    chunksSentSinceLastRateUpdate,
    currentTransferRateBps,

    // Receiver State Snapshot
    qrScanner,
    isScanning,
    expectedFileId,
    expectedTotalChunks,
    expectedArchiveName,
    expectedDataSize,
    expectedIsZip,
    expectedOriginalFilename,
    receivedChunksMap, // Note: This provides direct access to the Map object
    receivedChunkCount,
    receiverState,
    receiverStartTime,
    receiverLastRateUpdateTime,
    receiverBytesSinceLastUpdate,
    receiverCurrentRateBps,
});

// --- State Modification (Setters & Actions) ---

// --- Sender Setters/Actions ---

/** Sets the files selected by the user and related info. */
export function setSenderFiles(
    files: File[],
    singleOriginal: boolean,
    originalName: string | null
): void {
    filesToSend = files;
    isSingleFileOriginal = singleOriginal;
    originalSingleFilename = originalName;
}

/** Sets the processed data (buffer, base64, checksum) after zipping. */
export function setSenderProcessedData(
    buffer: ArrayBuffer | null,
    b64: string,
    checksum: string
): void {
    dataToSendBuffer = buffer;
    base64Data = b64;
    dataToSendChecksum = checksum;
    // Reset chunk-related state when new data is processed
    chunks = [];
    totalDataChunks = 0;
    currentChunkIndex = -1;
}

/** Sets the calculated data chunks and updates the total count. */
export function setSenderChunks(newChunks: string[]): void {
    chunks = newChunks;
    totalDataChunks = newChunks.length;
    // Reset chunk index when chunks are reset/recalculated
    currentChunkIndex = -1;
}

/** Sets the current phase of the sender state machine. */
export function setSenderPhase(phase: SenderPhase): void {
    senderTransferPhase = phase;
}

/** Sets the index of the next chunk to be processed/displayed. */
export function setCurrentChunkIndex(index: number): void {
    currentChunkIndex = index;
}

/** Sets the unique ID for the current transfer session. */
export function setTransferFileId(id: string): void {
    transferFileId = id;
}

/** Sets the timer ID used for automatic QR sequencing. */
export function setTransferTimer(timer: number | null): void {
    // Ensure any previous timer is cleared before setting a new one
    if (transferTimer !== null && timer !== transferTimer) {
        clearTimeout(transferTimer);
    }
    transferTimer = timer;
}

/** Sets the list of specific chunk sequence numbers to resend. */
export function setSpecificChunksToSend(specificChunks: number[]): void {
    specificChunksToSend = specificChunks;
}

/** Sets the index within the specific chunks list being sent. */
export function setSpecificChunkSendIndex(index: number): void {
    specificChunkSendIndex = index;
}

/** Sets the start timestamp for transfer rate calculation. */
export function setTransferStartTime(time: number): void {
    transferStartTime = time;
}

/** Sets the total number of QRs in the current sequence (main or specific). */
export function setTotalStepsInCurrentSequence(steps: number): void {
    totalStepsInCurrentSequence = steps;
}

/** Sets the timestamp of the last sender rate update. */
export function setLastRateUpdateTime(time: number): void {
    lastRateUpdateTime = time;
}

/** Sets the count of chunks sent since the last sender rate update. */
export function setChunksSentSinceLastRateUpdate(count: number): void {
    chunksSentSinceLastRateUpdate = count;
}

/** Sets the calculated sender transfer rate. */
export function setCurrentTransferRateBps(rate: number | null): void {
    currentTransferRateBps = rate;
}

/** Increments the counter for chunks sent since the last rate update. */
export function incrementChunksSentSinceRateUpdate(): void {
    chunksSentSinceLastRateUpdate++;
}

// --- Receiver Setters/Actions ---

/** Sets the QrScanner library instance. */
export function setQrScanner(instance: QrScanner | null): void {
    // Clean up old scanner instance if setting a new one or nulling it
    if (qrScanner && qrScanner !== instance) {
        try {
            qrScanner.stop();
            qrScanner.destroy();
        } catch (e) {
            console.warn("Error destroying previous QR scanner instance:", e);
        }
    }
    qrScanner = instance;
}

/** Sets the scanning status of the receiver. */
export function setIsScanning(scanning: boolean): void {
    isScanning = scanning;
}

/** Sets the state of the receiver state machine. */
export function setReceiverState(newState: ReceiverState): void {
    // Renamed param to avoid conflict
    receiverState = newState;
}

/** Sets the expected file ID for the current transfer. */
export function setExpectedFileId(id: string | null): void {
    expectedFileId = id;
}

/** Sets the metadata expected from the handshake packet. */
export function setExpectedData(
    archiveName: string | null,
    dataSize: number | null,
    totalChunks: number | null,
    isZip: boolean,
    originalFilename: string | null
): void {
    expectedArchiveName = archiveName;
    expectedDataSize = dataSize;
    expectedTotalChunks = totalChunks;
    expectedIsZip = isZip;
    expectedOriginalFilename = originalFilename;
}

/** Clears the map of received chunks and resets the count. */
export function clearReceivedChunks(): void {
    receivedChunksMap.clear();
    receivedChunkCount = 0;
}

/**
 * Adds a received chunk to the map if it's not already present.
 * Increments the received chunk count only if the chunk is new.
 * @param seq - The sequence number (1-based) of the chunk.
 * @param data - The base64 encoded data of the chunk.
 */
export function addReceivedChunk(seq: number, data: string): void {
    // Only add and increment count if the chunk is actually new
    if (!receivedChunksMap.has(seq)) {
        receivedChunksMap.set(seq, data);
        receivedChunkCount++;
        // console.log(`Added chunk ${seq}. Total unique: ${receivedChunkCount}`);
    } else {
        // console.log(`Chunk ${seq} already received.`); // Avoid excessive logging
    }
}

/** Sets the start timestamp for receiver rate calculation. */
export function setReceiverStartTime(time: number): void {
    receiverStartTime = time;
}

/** Sets the timestamp of the last receiver rate update. */
export function setReceiverLastRateUpdateTime(time: number): void {
    receiverLastRateUpdateTime = time;
}

/** Sets the count of bytes received since the last receiver rate update. */
export function setReceiverBytesSinceLastUpdate(bytes: number): void {
    receiverBytesSinceLastUpdate = bytes;
}

/** Sets the calculated receiver transfer rate. */
export function setReceiverCurrentRateBps(rate: number | null): void {
    receiverCurrentRateBps = rate;
}

/** Adds bytes to the count received since the last receiver rate update. */
export function addReceiverBytesSinceLastUpdate(bytes: number): void {
    receiverBytesSinceLastUpdate += bytes;
}

// --- Internal State Reset Functions ---

/**
 * Resets the sender-specific state variables to their initial values.
 * Used when stopping a transfer, finishing, or selecting new files.
 * @param clearFiles - If true, also clears file selection and processed data (full reset).
 *                     If false, keeps loaded file data but resets transfer progress.
 */
export function resetSenderStateInternal(clearFiles = true): void {
    console.log(`Resetting Sender State (clearFiles: ${clearFiles})`);
    // Clear transfer timer regardless
    if (transferTimer !== null) {
        clearTimeout(transferTimer);
        transferTimer = null;
    }

    // Reset transfer progress and control variables
    senderTransferPhase = clearFiles
        ? "idle"
        : dataToSendBuffer
        ? "ready"
        : "idle"; // Set to ready if keeping files and data exists
    specificChunksToSend = [];
    specificChunkSendIndex = 0;
    currentTransferRateBps = null;
    transferStartTime = 0;
    lastRateUpdateTime = 0;
    chunksSentSinceLastRateUpdate = 0;
    totalStepsInCurrentSequence = 0;
    currentChunkIndex = -1; // Reset index
    transferFileId = ""; // Clear transfer ID

    // Reset chunk data (always reset when transfer stops/resets)
    chunks = [];
    totalDataChunks = 0; // Reset chunk count

    // Conditionally reset file data based on clearFiles flag
    if (clearFiles) {
        filesToSend = [];
        dataToSendBuffer = null;
        base64Data = "";
        dataToSendChecksum = "";
        isSingleFileOriginal = false;
        originalSingleFilename = null;
        senderTransferPhase = "idle"; // Ensure idle if files cleared
    }
}

/**
 * Resets the receiver-specific state variables to their initial values.
 * Used when starting a new scan, after successful completion, or on error.
 * Does NOT automatically stop the scanner instance here, that's handled separately.
 */
export function resetReceiverStateInternal(): void {
    console.log("Resetting Receiver State");
    receiverState = "idle";
    expectedFileId = null;
    expectedTotalChunks = null;
    expectedArchiveName = null;
    expectedDataSize = null;
    expectedIsZip = false;
    expectedOriginalFilename = null;
    receivedChunksMap.clear(); // Clear the map
    receivedChunkCount = 0; // Reset the count
    receiverCurrentRateBps = null;
    receiverStartTime = 0;
    receiverLastRateUpdateTime = 0;
    receiverBytesSinceLastUpdate = 0;

    // Note: Does not reset qrScanner instance itself, only the transfer state.
    // isScanning flag is managed by startScan/stopScan.
}

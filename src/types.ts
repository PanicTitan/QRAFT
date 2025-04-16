/**
 * @file types.ts
 * Contains TypeScript type definitions and interfaces used across the application,
 * particularly for state management and QR code payload structures.
 */

import { ErrorCorrectionLevel } from "qr-code-styling"; // Import if needed, though maybe not directly here

// --- QR Code Payload Types ---

/** Base interface for all QR code payload types. */
export interface QRPayloadBase {
    /** Protocol version number for compatibility checking. */
    v: number;
    /** Unique identifier for the specific file transfer session. */
    fid: string;
    /** Type of the payload: Handshake ('h'), Data ('d'), or Final ('f'). */
    typ: "h" | "d" | "f";
}

/**
 * Payload for the initial handshake QR code.
 * Contains metadata about the file(s) being transferred.
 */
export interface QRHandshakePayload extends QRPayloadBase {
    typ: "h";
    /** Filename (URI Encoded). Always the archive name (e.g., "transfer_archive.zip"). */
    nam: string;
    /** Total size of the ZIPPED data being transferred (in bytes). */
    siz: number;
    /** Total number of data chunks ('d' type payloads) that will follow. */
    tot: number;
    /** Flag indicating the data is zipped (currently always true). */
    zip: true;
    /** OPTIONAL: Original filename (URI encoded) if only a single file was selected by the sender. */
    ofn?: string;
}

/**
 * Payload for a data chunk QR code.
 * Contains a portion of the base64 encoded zipped file data.
 */
export interface QRDataPayload extends QRPayloadBase {
    typ: "d";
    /** Sequence number of this data chunk (1-based index). */
    seq: number;
    /** Base64 encoded string representing a chunk of the zipped data. */
    dat: string;
}

/**
 * Payload for the final confirmation QR code.
 * Contains a checksum of the entire zipped data that was transferred.
 */
export interface QRFinalPayload extends QRPayloadBase {
    typ: "f";
    /** Checksum (e.g., simple sum modulo 65536, hex encoded) of the complete zipped data. */
    chk: string;
}

/** Union type representing any possible valid QR payload structure. */
export type QRPayload = QRHandshakePayload | QRDataPayload | QRFinalPayload;

// --- Application State Types ---

/** Possible phases for the sender state machine. */
export type SenderPhase =
    | "idle" // Waiting for file selection or start command.
    | "processing" // File selected, zipping/processing in progress.
    | "ready" // Processing done, ready to start transfer.
    | "transferring" // Actively displaying the main sequence of QRs (h, d..., f).
    | "final_qr_displayed" // The final 'f' QR is currently displayed, awaiting next action (auto or manual).
    | "post_final" // Main sequence finished, showing resend options in modal.
    | "sending_specific" // Actively displaying specific requested chunks.
    | "error"; // An error occurred on the sender side.

/** Possible states for the receiver state machine. */
export type ReceiverState =
    | "idle" // Initial state, scanner not running.
    | "waiting_handshake" // Scanner running, waiting for the first 'h' packet.
    | "receiving_data" // Handshake received, actively scanning for 'd' or 'f' packets.
    | "waiting_final" // All 'd' chunks received, waiting only for the 'f' packet.
    | "waiting_missing" // 'f' packet seen, but 'd' chunks are missing; still scanning for 'd' or 'f'.
    | "verifying" // All chunks + final received, assembling and verifying data.
    | "complete" // Verification successful, download triggered. Ready for next scan.
    | "error"; // An error occurred on the receiver side.

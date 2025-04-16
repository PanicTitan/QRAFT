/**
 * @file config.ts
 * Contains constants and configuration values used throughout the application.
 */

// --- Protocol ---
/** Version number embedded in QR code payloads to ensure compatibility between sender and receiver. */
export const PROTOCOL_VERSION = 1;

// --- File Handling ---
/** Default filename used when multiple files/folders are zipped together for transfer. */
export const MULTI_FILE_ARCHIVE_NAME = "transfer_archive.zip";

// --- QR Code Generation ---
/**
 * Approximate maximum data bytes reliably fitting in a QR code for different error correction levels.
 * These are conservative estimates, factoring in overhead for JSON structure, keys, and base64 encoding.
 * The actual capacity depends on the QR code library, version (size), and data content.
 * Using 'Byte' mode capacity for QR version 40 (largest standard).
 * L: ~2953 bytes -> effective ~2400 after overhead/safety margin? Let's be more conservative.
 * M: ~2331 bytes -> effective ~1800
 * Q: ~1663 bytes -> effective ~1300
 * H: ~1273 bytes -> effective ~1000
 * Adjusted these downwards significantly for practical reliability.
 */
export const QR_CAPACITY_ESTIMATES: Record<string, number> = {
    L: 2000, // Low
    M: 1500, // Medium
    Q: 1100, // Quartile
    H: 800, // High
};

/** Buffer subtracted from estimated capacity when calculating default chunk size. */
export const QR_CHUNK_SIZE_BUFFER = 150; // Increased buffer for more headroom

/** Minimum allowed chunk size to prevent excessively small chunks. */
export const MIN_CHUNK_SIZE = 100;

/** Maximum allowed chunk size (theoretical limit, rarely achievable). */
export const MAX_CHUNK_SIZE_LIMIT = 2900;

// --- Transfer ---
/** Default delay (in milliseconds) between displaying consecutive QR codes in automatic mode. */
export const DEFAULT_DELAY_MS = 500;

/** Minimum allowed delay (in milliseconds) to prevent overly fast transitions. */
export const MIN_DELAY_MS = 50;

/** Interval (in milliseconds) for updating the transfer rate calculation. */
export const RATE_UPDATE_INTERVAL_MS = 1000; // Update rate roughly every second

/** Minimum number of chunks sent before recalculating rate (used with interval). */
export const RATE_UPDATE_MIN_CHUNKS = 2;

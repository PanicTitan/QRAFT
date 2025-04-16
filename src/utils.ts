/**
 * @file utils.ts
 * Contains various utility functions used throughout the application.
 * Includes functions for data conversion (base64), checksum calculation,
 * file downloads, time formatting, input parsing, and QR code capacity estimation.
 */

import { ErrorCorrectionLevel } from "qr-code-styling"; // Used for type hint
import * as config from "./config"; // Import config for constants

/**
 * Converts an ArrayBuffer containing binary data into a Base64 encoded string.
 * @param buffer - The ArrayBuffer to convert.
 * @returns The Base64 encoded string.
 */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
    let binary = "";
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    // Avoid String.fromCharCode.apply for large buffers to prevent stack overflow
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    try {
        return window.btoa(binary);
    } catch (e) {
        console.error("Error encoding to Base64:", e);
        // Consider throwing the error or returning an empty string/null
        // depending on how callers should handle this failure.
        throw new Error(
            `Failed to encode ArrayBuffer to Base64: ${
                e instanceof Error ? e.message : String(e)
            }`
        );
    }
}

/**
 * Converts a Base64 encoded string back into an ArrayBuffer.
 * Handles potential decoding errors gracefully.
 * @param base64 - The Base64 encoded string.
 * @returns The resulting ArrayBuffer, or an empty ArrayBuffer if decoding fails.
 */
export function base64ToArrayBuffer(base64: string): ArrayBuffer {
    try {
        const binary_string = window.atob(base64);
        const len = binary_string.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            bytes[i] = binary_string.charCodeAt(i);
        }
        return bytes.buffer;
    } catch (e) {
        console.error("Base64 Decode Error:", e);
        // Return empty buffer on error - signifies failure to the caller
        return new ArrayBuffer(0);
    }
}

/**
 * Calculates a simple checksum for an ArrayBuffer (sum of bytes modulo 2^16).
 * Used for basic data integrity verification. Not cryptographically secure.
 * @param buffer - The ArrayBuffer to calculate the checksum for.
 * @returns A 4-character hexadecimal string representing the checksum.
 */
export function calculateChecksum(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let sum = 0;
    for (let i = 0; i < bytes.length; i++) {
        sum = (sum + bytes[i]) % 65536; // Modulo 2^16
    }
    // Convert to hexadecimal string, padded to 4 characters with leading zeros
    return sum.toString(16).padStart(4, "0");
}

/**
 * Triggers a browser file download for the given ArrayBuffer data.
 * @param arrayBuffer - The data to be downloaded.
 * @param filename - The suggested filename for the downloaded file.
 */
export function triggerFileDownload(
    arrayBuffer: ArrayBuffer,
    filename: string
): void {
    try {
        // Create a Blob from the ArrayBuffer
        // Specify MIME type if known, otherwise use generic octet-stream
        const blob = new Blob([arrayBuffer], {
            type: "application/octet-stream",
        });

        // Create a temporary URL for the Blob
        const url = URL.createObjectURL(blob);

        // Create a temporary anchor element
        const a = document.createElement("a");
        a.href = url;
        a.download = filename || "downloaded_file"; // Use provided filename or a default
        a.style.display = "none"; // Hide the anchor element

        // Append the anchor to the body, click it, then remove it
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);

        // Revoke the temporary URL to free up resources
        URL.revokeObjectURL(url);
        console.log(`Download triggered for: ${filename}`);
    } catch (e) {
        console.error("File Download Error:", e);
        // Rethrow or handle UI update externally (e.g., via event or callback)
        // Avoid direct UI updates from utility functions.
        throw new Error(
            `Failed to trigger download for ${filename}: ${
                e instanceof Error ? e.message : String(e)
            }`
        );
    }
}

/**
 * Formats a duration in seconds into a human-readable string (MM:SS or HH:MM:SS).
 * Prefixes with '~' to indicate it's an estimate.
 * @param totalSeconds - The total number of seconds.
 * @returns A formatted time string (e.g., "~01:23", "~1:15:42") or an empty string for invalid input.
 */
export function formatTime(totalSeconds: number): string {
    if (isNaN(totalSeconds) || totalSeconds < 0 || !isFinite(totalSeconds)) {
        return ""; // Return empty string for invalid input (NaN, negative, Infinity)
    }

    // Handle zero duration specifically
    if (totalSeconds === 0) {
        return "~00:00";
    }

    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = Math.floor(totalSeconds % 60);

    // Pad minutes and seconds with leading zeros if needed
    const paddedSeconds = seconds.toString().padStart(2, "0");
    const paddedMinutes = minutes.toString().padStart(2, "0");

    if (hours > 0) {
        // Format as HH:MM:SS
        // No need to pad hours if it's > 0
        return `~${hours}:${paddedMinutes}:${paddedSeconds}`;
    } else {
        // Format as MM:SS
        return `~${paddedMinutes}:${paddedSeconds}`;
    }
}

/**
 * Formats a transfer rate from Bytes per second (Bps) to KB/s or MB/s.
 * @param bytesPerSecond - The transfer rate in bytes per second.
 * @returns A formatted rate string (e.g., "123.4 KB/s", "1.5 MB/s") or "?" if input is invalid.
 */
export function formatBytesPerSecond(bytesPerSecond: number | null): string {
    if (
        bytesPerSecond === null ||
        isNaN(bytesPerSecond) ||
        bytesPerSecond < 0
    ) {
        return "? KB/s"; // Return placeholder for invalid input
    }
    if (bytesPerSecond < 1024) {
        // Show B/s for very low rates
        return `${bytesPerSecond.toFixed(0)} B/s`;
    }
    const kilobytesPerSecond = bytesPerSecond / 1024;
    if (kilobytesPerSecond < 1024) {
        // Show KB/s
        return `${kilobytesPerSecond.toFixed(1)} KB/s`;
    }
    const megabytesPerSecond = kilobytesPerSecond / 1024;
    // Show MB/s
    return `${megabytesPerSecond.toFixed(1)} MB/s`;
}

/**
 * Parses a user input string representing chunk numbers or ranges (e.g., "1,3,5-8,10").
 * Validates the input against the maximum allowed chunk number.
 * @param input - The raw input string from the user.
 * @param maxChunk - The highest valid chunk sequence number (1-based).
 * @returns An array of unique, sorted chunk numbers, or null if the input is invalid. Returns empty array if input is empty/whitespace.
 */
export function parseChunkInput(
    input: string,
    maxChunk: number
): number[] | null {
    if (!input || input.trim() === "") {
        return []; // Return empty array for empty input
    }
    if (maxChunk <= 0) {
        console.error("Cannot parse chunk input: maxChunk must be positive.");
        return null; // Invalid maxChunk
    }

    const uniqueChunks = new Set<number>();
    const parts = input.split(",");

    for (const part of parts) {
        const trimmedPart = part.trim();
        if (trimmedPart === "") continue; // Ignore empty segments

        if (trimmedPart.includes("-")) {
            // Handle ranges (e.g., "5-8")
            const rangeParts = trimmedPart.split("-");
            if (rangeParts.length !== 2) return null; // Invalid range format (e.g., "1-2-3")

            const startStr = rangeParts[0].trim();
            const endStr = rangeParts[1].trim();

            // Strict integer parsing
            if (!/^\d+$/.test(startStr) || !/^\d+$/.test(endStr)) return null;

            const start = parseInt(startStr, 10);
            const end = parseInt(endStr, 10);

            // Validate range values
            if (
                isNaN(start) ||
                isNaN(end) ||
                start <= 0 ||
                end < start ||
                start > maxChunk ||
                end > maxChunk
            ) {
                console.log(
                    `Invalid range part: ${trimmedPart} (start=${start}, end=${end}, max=${maxChunk})`
                );
                return null; // Invalid number, order, or exceeds max
            }

            // Add all numbers in the valid range to the set
            for (let i = start; i <= end; i++) {
                uniqueChunks.add(i);
            }
        } else {
            // Handle single numbers (e.g., "3")
            // Strict integer parsing
            if (!/^\d+$/.test(trimmedPart)) return null;

            const num = parseInt(trimmedPart, 10);

            // Validate single number value
            if (isNaN(num) || num <= 0 || num > maxChunk) {
                console.log(
                    `Invalid single chunk number: ${trimmedPart} (num=${num}, max=${maxChunk})`
                );
                return null; // Invalid number or exceeds max
            }
            uniqueChunks.add(num);
        }
    }

    // Convert the set to a sorted array
    return Array.from(uniqueChunks).sort((a, b) => a - b);
}

/**
 * Provides a *conservative estimate* of the maximum data bytes that can fit
 * in a QR code payload for a given error correction level.
 * Accounts for base64 encoding overhead and JSON structure/keys.
 * Uses values from `config.ts`.
 * @param level - The selected error correction level ('L', 'M', 'Q', 'H').
 * @returns An estimated capacity in bytes.
 */
export function getQrCapacityEstimate(level: ErrorCorrectionLevel): number {
    // Use estimates defined in config, fallback to a conservative value if level is unexpected
    return (
        config.QR_CAPACITY_ESTIMATES[level] || config.QR_CAPACITY_ESTIMATES["M"]
    ); // Default to Medium capacity
}

/**
 * Estimates the non-data overhead (metadata size) in bytes for a given QR payload type.
 * Helps in calculating the maximum data chunk size that can fit.
 * @param payloadType - The type of payload ('h', 'd', 'f').
 * @param fileId - The file transfer ID (used in all payloads).
 * @param archiveNameLength - Length of the URI-encoded archive name (for 'h').
 * @param originalFilenameLength - Length of the URI-encoded original filename (optional, for 'h').
 * @returns An estimated size of the metadata in bytes.
 */
export function estimateMetadataSize(
    payloadType: "h" | "d" | "f",
    fileId: string | null, // Can be null before transfer starts
    archiveNameLength = config.MULTI_FILE_ARCHIVE_NAME.length, // Assume default archive name length
    originalFilenameLength = 0 // Assume no original filename by default
): number {
    // Base structure overhead: {"v":1,"fid":"","typ":""} + commas/quotes
    // Rough estimate: ~30 bytes + length of fileId
    let size = 30 + (fileId?.length || 15); // Use 15 as placeholder length if fid is null

    if (payloadType === "h") {
        // Handshake adds: ,"nam":"","siz":12345,"tot":123,"zip":true,"ofn":"" (optional)
        // Estimate: ~25 bytes fixed + name length + size num (~5) + tot num (~3) + zip (~5) + ofn (optional)
        size += 25 + archiveNameLength + 5 + 3 + 5;
        if (originalFilenameLength > 0) {
            // ,"ofn":"" -> ~10 bytes + length
            size += 10 + originalFilenameLength;
        }
    } else if (payloadType === "d") {
        // Data adds: ,"seq":123,"dat":""
        // Estimate: ~15 bytes fixed + seq num (~3) + dat key (~5)
        size += 15 + 3 + 5; // Extra buffer here is included in QR_CHUNK_SIZE_BUFFER
    } else if (payloadType === "f") {
        // Final adds: ,"chk":"abcd"
        // Estimate: ~15 bytes fixed + chk key (~5) + chk value (4)
        size += 15 + 5 + 4;
    }

    // Add a small general buffer for JSON syntax, quotes etc.
    size += 10;

    return Math.ceil(size); // Return integer estimate
}

/**
 * Safely decodes a URI component, returning a fallback if decoding fails.
 * @param encodedString The URI encoded string.
 * @param fallback The string to return if decoding fails.
 * @returns The decoded string or the fallback.
 */
export function safeDecodeURIComponent(
    encodedString: string,
    fallback: string | null = ""
): string | null {
    try {
        return decodeURIComponent(encodedString);
    } catch (e) {
        console.warn(
            `Failed to decode URI component: "${encodedString}". Error: ${e}`
        );
        return fallback;
    }
}

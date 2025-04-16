/**
 * @file dom.ts
 * Centralized module for selecting and exporting DOM elements.
 * This avoids repeated document.getElementById/querySelector calls throughout the codebase.
 * Uses non-null assertion (!) assuming elements always exist in index.html. Handle with care.
 */

// --- Main Application & Navigation ---
export const app = document.getElementById('app')!;
export const navigation = document.getElementById('navigation')!;
export const senderView = document.getElementById('senderView')!;
export const receiverView = document.getElementById('receiverView')!;
export const showSenderBtn = document.getElementById('showSenderBtn')!;
export const showReceiverBtn = document.getElementById('showReceiverBtn')!;

// --- Sender View Elements ---
export const fileInput = document.getElementById('fileInput') as HTMLInputElement;
export const errorCorrectionLevelSelect = document.getElementById('errorCorrectionLevel') as HTMLSelectElement;
export const chunkSizeInput = document.getElementById('chunkSize') as HTMLInputElement;
export const delayInput = document.getElementById('delay') as HTMLInputElement;
export const manualModeCheckbox = document.getElementById('manualMode') as HTMLInputElement; // For initial transfer
export const startTransferBtn = document.getElementById('startTransferBtn') as HTMLButtonElement;
export const senderStatus = document.getElementById('senderStatus')!;
export const senderProgress = document.getElementById('senderProgress')!;
export const senderEstimates = document.getElementById('senderEstimates')!;
export const senderTransferRate = document.getElementById('senderTransferRate')!;

// --- Receiver View Elements ---
export const startScanBtn = document.getElementById('startScanBtn') as HTMLButtonElement;
export const stopScanBtn = document.getElementById('stopScanBtn') as HTMLButtonElement;
export const receiverVideoContainer = document.getElementById('receiverVideoContainer')!;
export const receiverVideo = document.getElementById('receiverVideo') as HTMLVideoElement;
export const receiverStatus = document.getElementById('receiverStatus')!;
export const receiverProgress = document.getElementById('receiverProgress') as HTMLProgressElement;
export const receivedFileInfo = document.getElementById('receivedFileInfo')!;
export const receiverDebug = document.getElementById('receiverDebug')!; // For optional debug messages
export const missingChunksInfo = document.getElementById('missingChunksInfo')!;
export const missingChunksList = document.getElementById('missingChunksList')!;
export const missingChunksCount = document.getElementById('missingChunksCount')!;
export const receiverTransferRate = document.getElementById('receiverTransferRate')!;

// --- QR Code Modal Elements ---
export const qrOverlay = document.getElementById('qrOverlay')!;
export const qrModalContent = document.getElementById('qrModalContent')!;
export const qrDisplayArea = document.getElementById('qrDisplayArea')!;
/** Dedicated container where the QR code canvas/svg will be injected. */
export const qrCodeContainer = document.getElementById('qrCodeContainer')!;
export const qrModalStatus = document.getElementById('qrModalStatus')!;
export const qrModalTimeEstimate = document.getElementById('qrModalTimeEstimate')!;
export const qrModalTransferRate = document.getElementById('qrModalTransferRate')!;
export const nextChunkBtn = document.getElementById('nextChunkBtn') as HTMLButtonElement; // For manual mode steps
export const stopTransferBtn = document.getElementById('stopTransferBtn') as HTMLButtonElement; // In modal

// --- Sender Post-Transfer Options (within Modal) ---
export const senderPostTransferOptions = document.getElementById('senderPostTransferOptions')!;
export const finishTransferBtn = document.getElementById('finishTransferBtn') as HTMLButtonElement;
export const resendAllBtn = document.getElementById('resendAllBtn') as HTMLButtonElement;
export const specificChunksInput = document.getElementById('specificChunksInput') as HTMLInputElement;
export const sendSpecificBtn = document.getElementById('sendSpecificBtn') as HTMLButtonElement;
export const sendSpecificStatus = document.getElementById('sendSpecificStatus')!;
/** Checkbox within post-transfer options to control manual mode FOR RESENDS. */
export const resendManualModeCheckbox = document.getElementById('resendManualModeCheckbox') as HTMLInputElement; // Added export
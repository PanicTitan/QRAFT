/**
 * @file main.ts
 * Entry point for the QR Code File Transfer application.
 * - Initializes views and routing.
 * - Sets up global event listeners for UI elements (navigation, buttons, inputs).
 * - Coordinates interactions between sender, receiver, state, and DOM modules.
 * - Generates and manages the Receiver Link QR code.
 */

import "./style.css"; // Import main stylesheet
import * as dom from "./dom"; // Import DOM element references
import * as state from "./state"; // Import state management
import * as sender from "./sender"; // Import sender logic
import * as receiver from "./receiver"; // Import receiver logic
import QRCodeStyling, {
    Options as QRCodeStylingOptions,
    ErrorCorrectionLevel,
} from "qr-code-styling"; // Import QR styling library

// --- Receiver Link QR Code Logic ---

let receiverLinkQrInstanceLarge: QRCodeStyling | null = null; // Instance for the large modal QR
const receiverUrl = `${window.location.origin}${window.location.pathname}#receiver`; // Construct receiver URL robustly

/**
 * Generates the small QR code linking to the receiver page.
 */
function generateReceiverLinkQrSmall(): void {
    const options: QRCodeStylingOptions = {
        width: 40,
        height: 40,
        data: receiverUrl,
        margin: 2, // Minimal margin for small size
        qrOptions: {
            errorCorrectionLevel: "L", // Low correction is fine for a simple URL
            mode: "Byte",
        },
        dotsOptions: { type: "square", color: "#444" }, // Dark grey dots
        backgroundOptions: { color: "#ffffff" },
    };

    // Clear previous content (if any)
    dom.receiverLinkQrContainer.innerHTML = "";
    const qrInstance = new QRCodeStyling(options);
    qrInstance.append(dom.receiverLinkQrContainer);
    console.log("Generated small receiver link QR code for:", receiverUrl);
}

/**
 * Generates the large QR code for the receiver link inside the modal.
 */
function generateReceiverLinkQrLarge(): void {
    const options: QRCodeStylingOptions = {
        width: 300,
        height: 300,
        data: receiverUrl,
        margin: 10,
        qrOptions: {
            errorCorrectionLevel: "M", // Medium correction for better scanning
            mode: "Byte",
        },
        dotsOptions: { type: "square", color: "#000000" },
        backgroundOptions: { color: "#ffffff" },
    };

    // Clear previous large QR if exists
    dom.receiverLinkQrCodeLarge.innerHTML = "";

    // Create and append new instance
    receiverLinkQrInstanceLarge = new QRCodeStyling(options);
    receiverLinkQrInstanceLarge.append(dom.receiverLinkQrCodeLarge);
    console.log("Generated large receiver link QR code.");
}

/**
 * Shows the modal containing the large receiver link QR code.
 */
function showReceiverLinkQrModal(): void {
    // Populate the URL text
    dom.receiverLinkQrUrl.textContent = receiverUrl;
    // Generate the large QR code *when showing* the modal
    generateReceiverLinkQrLarge();
    // Show the overlay
    dom.receiverLinkQrOverlay.classList.remove("hidden");
}

/**
 * Hides the receiver link QR code modal.
 */
function hideReceiverLinkQrModal(): void {
    dom.receiverLinkQrOverlay.classList.add("hidden");
    // Optional: Clear the large QR instance when hiding to save memory
    dom.receiverLinkQrCodeLarge.innerHTML = "";
    receiverLinkQrInstanceLarge = null;
    console.log("Hid large receiver link QR code modal.");
}

// --- View Management ---

/**
 * Switches the visible view between Sender and Receiver.
 * Stops any ongoing transfers or scans when switching.
 * Updates the URL hash to reflect the current view.
 * @param viewId - The ID of the view to show ('sender' or 'receiver').
 */
function showView(viewId: "sender" | "receiver"): void {
    console.log(`Switching view to: ${viewId}`);
    const currentState = state.getState();

    // --- Stop ongoing processes before switching ---
    // Stop sender transfer if active
    if (
        currentState.senderTransferPhase !== "idle" &&
        currentState.senderTransferPhase !== "ready" &&
        currentState.senderTransferPhase !== "processing"
    ) {
        // Stop transfer but keep loaded files/data
        console.log("Sender transfer/display in progress, stopping...");
        sender.handleStopTransfer(false); // false = keep file data loaded
    }

    // Stop receiver scan if active
    if (currentState.isScanning && currentState.qrScanner) {
        console.log("Receiver scanning in progress, stopping...");
        receiver.stopScan();
    }

    // --- Update View Visibility ---
    dom.senderView.classList.add("hidden");
    dom.receiverView.classList.add("hidden");

    if (viewId === "sender") {
        dom.senderView.classList.remove("hidden");
        // Ensure sender UI is consistent if data is loaded
        if (currentState.dataToSendBuffer) {
            sender.prepareChunks(); // Recalculate chunks/estimates
            sender.updateSenderStatus(
                "File loaded. Ready to start transfer.",
                false
            );
            dom.startTransferBtn.disabled = false;
        } else if (currentState.senderTransferPhase === "idle") {
            sender.updateSenderStatus("Ready. Select file/folder.", false);
            dom.startTransferBtn.disabled = true;
            sender.displayEstimates(); // Show initial estimate text
        }
    } else {
        // viewId === 'receiver'
        dom.receiverView.classList.remove("hidden");
        // Ensure receiver UI is reset/updated correctly
        receiver.updateReceiverUI();
    }

    // --- Update URL Hash ---
    // Avoid pushing same hash repeatedly to history
    if (window.location.hash !== `#${viewId}`) {
        window.location.hash = viewId;
    }
}

// --- Global Event Listeners Setup ---

/**
 * Attaches all necessary event listeners to DOM elements.
 */
function setupEventListeners(): void {
    // --- Navigation ---
    dom.showSenderBtn.addEventListener("click", () => showView("sender"));
    dom.showReceiverBtn.addEventListener("click", () => showView("receiver"));

    // --- Receiver Link QR Code Modal ---
    dom.receiverLinkQrContainer.addEventListener(
        "click",
        showReceiverLinkQrModal
    );
    dom.receiverLinkCloseBtn.addEventListener("click", hideReceiverLinkQrModal);
    // Hide modal if user clicks on the overlay background
    dom.receiverLinkQrOverlay.addEventListener("click", (event) => {
        if (event.target === dom.receiverLinkQrOverlay) {
            hideReceiverLinkQrModal();
        }
    });

    // --- Sender View ---
    dom.fileInput.addEventListener("change", sender.handleFileSelect);
    dom.startTransferBtn.addEventListener("click", sender.startTransfer);

    // Reactive Sender Inputs (update estimates/chunks immediately)
    dom.errorCorrectionLevelSelect.addEventListener("change", () => {
        console.log("EC Level changed");
        sender.updateChunkSizeDefaults(); // Updates chunk size input AND calls prepareChunks/displayEstimates
    });
    dom.chunkSizeInput.addEventListener("input", () => {
        console.log("Chunk size input changed");
        // Need to re-prepare chunks as size limit changes
        sender.prepareChunks(); // This recalculates chunks and then calls displayEstimates
    });
    dom.delayInput.addEventListener("input", () => {
        console.log("Delay input changed");
        // Only affects time estimate, not chunking
        sender.displayEstimates();
    });
    dom.manualModeCheckbox.addEventListener("change", () => {
        console.log("Manual mode changed");
        // Only affects time estimate and button visibility during transfer
        sender.displayEstimates();
        // If transfer is active, update modal buttons/text immediately? (Handled within displayNextChunk logic)
    });

    // --- QR Modal (Sender - Main Transfer) ---
    dom.nextChunkBtn.addEventListener("click", () => {
        // Determine action based on current sender phase
        const currentPhase = state.getState().senderTransferPhase;
        console.log(`Next Chunk button clicked in phase: ${currentPhase}`);
        if (currentPhase === "transferring") {
            sender.displayNextChunk(); // Display next in main sequence
        } else if (currentPhase === "sending_specific") {
            sender.displaySpecificChunk(); // Display next specific chunk
        } else if (currentPhase === "final_qr_displayed") {
            // Action after final QR shown (manual): show options or display final confirmation
            const nextIndex = state.getState().currentChunkIndex;
            // Check if final QR was displayed after specific send or main transfer
            if (dom.nextChunkBtn.textContent?.includes("Show Final QR")) {
                // Check button text as context
                sender.displayFinalConfirmationQR();
            } else {
                // Button should say "Show Resend Options"
                sender.handlePostFinalState(); // Go to resend options
            }
        } else {
            console.warn(
                `Next Chunk button clicked in unexpected phase: ${currentPhase}`
            );
        }
    });

    dom.stopTransferBtn.addEventListener("click", () => {
        console.log("Stop Transfer button clicked in modal.");
        // Determine action based on context (stop transfer vs. finish/close)
        const currentPhase = state.getState().senderTransferPhase;
        if (currentPhase === "post_final") {
            // Button acts as "Finish & Close"
            sender.handleStopTransfer(true); // True = full reset including files
        } else {
            // Button acts as "Stop Transfer" or "Stop Specific Send"
            sender.handleStopTransfer(false); // False = stop transfer but keep files loaded
        }
    });

    // Post-Transfer Options (Sender Modal)
    dom.finishTransferBtn.addEventListener("click", () => {
        console.log("Finish & Close button clicked.");
        sender.handleStopTransfer(true); // True = full reset including files
    });
    dom.resendAllBtn.addEventListener("click", sender.handleSendAllAgain);
    dom.sendSpecificBtn.addEventListener("click", sender.handleSendSpecific);

    // --- Receiver View ---
    dom.startScanBtn.addEventListener("click", receiver.startScan);
    dom.stopScanBtn.addEventListener("click", receiver.stopScan);

    // --- Browser Navigation (Hash Changes) ---
    window.addEventListener("hashchange", () => {
        console.log("Hash changed:", window.location.hash);
        const hash = window.location.hash;
        if (hash === "#receiver") {
            showView("receiver");
        } else {
            // Default to sender for '#', empty hash, or unknown hash
            showView("sender");
        }
    });
}

// --- Initialization ---

/**
 * Initializes the application on page load.
 */
function initializeApp(): void {
    console.log("Initializing QRAFT: QR Air-gap File Transfer App");

    // Generate the small receiver link QR code on initial load
    generateReceiverLinkQrSmall();

    // Set initial default chunk size based on default EC level
    sender.updateChunkSizeDefaults();

    // Setup all event listeners
    setupEventListeners();

    // Determine initial view based on URL hash or default to sender
    const initialHash = window.location.hash;
    if (initialHash === "#receiver") {
        showView("receiver");
    } else {
        showView("sender"); // Default view
    }

    // Initial UI state reset for both views
    state.resetSenderStateInternal(true); // Full reset for sender
    state.resetReceiverStateInternal();
    sender.clearQrInstance();
    receiver.updateReceiverUI(); // Set initial receiver UI state
    sender.updateSenderStatus("Ready. Select file/folder."); // Set initial sender status
    sender.displayEstimates(); // Show initial estimate text
    dom.startTransferBtn.disabled = true; // Ensure start button is disabled initially
    dom.senderProgress.textContent = "";
    dom.senderTransferRate.textContent = "";
}

// --- Run Initialization ---
initializeApp();

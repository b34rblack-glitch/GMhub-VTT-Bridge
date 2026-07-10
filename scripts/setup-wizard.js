// =============================================================================
// scripts/setup-wizard.js
// =============================================================================
//
// GMhub VTT Bridge — Guided setup wizard for first-run configuration.
//
// PURPOSE:
//   The SetupWizardDialog is a 3-step modal that guides first-time GMs
//   through: (1) pasting a GMhub personal-access token and validating it,
//   (2) selecting the campaign to bind to the world, and (3) optionally
//   mapping Foundry users to GMhub members. The wizard accumulates temp
//   state and writes all settings atomically only on completion, avoiding
//   partial configuration if the GM dismisses mid-flow.
//
// CLASS INVENTORY:
//   - SetupWizardDialog         — the main wizard Application
//
// PATTERNS:
//   - Temp state accumulator (`stepData`) cleared on cancel, flushed on finish
//   - safeCall() wrapper for all async API calls
//   - Modal-only, singleton pattern
//   - Unsaved-changes detection with confirm-close dialog
// =============================================================================

import { MODULE_ID } from "./main.js";
import { safeCall, showFriendlyError } from "./error-toaster.js";

// Static reference to the current wizard instance, if any. Prevents
// accidental double-open and lets us check if a wizard is already rendered.
let _currentWizardInstance = null;

// =============================================================================
// SetupWizardDialog
// =============================================================================
export class SetupWizardDialog extends Application {
  constructor(client, options = {}) {
    super(options);
    this.client = client;
    // Step state machine: 1, 2, or 3.
    this.currentStep = 1;
    // Temp accumulator for all step data. Written to world settings only
    // on _finalize() success. Discarded on cancel or dialog close without save.
    this.stepData = {
      step1: { token: "", validatedPrincipal: null },
      step2: { campaigns: [], campaignId: "", campaignSummary: null },
      step3: { playerMap: null }
    };
    // Busy flag: set while an async operation is in flight so we can
    // disable buttons and prevent double-clicks.
    this.isBusy = false;
    // Dirty flag: set whenever the user changes an input. Used by the
    // unsaved-changes detection on close.
    this.dirty = false;
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "gmhub-setup-wizard",
      title: "GMHUB.Dialog.SetupWizard.Title",
      template: `modules/${MODULE_ID}/templates/setup-wizard.hbs`,
      width: 520, height: "auto", classes: ["gmhub-setup-wizard-dialog"],
      modal: true
    });
  }

  // ---------------------------------------------------------------------------
  // Static: openSetupWizard(client)
  // ---------------------------------------------------------------------------
  // Factory that ensures only one wizard is open at a time. Returns the
  // wizard instance so callers can await its completion if needed.
  // ---------------------------------------------------------------------------
  static openSetupWizard(client) {
    // If a wizard is already rendered, focus it and return.
    if (_currentWizardInstance && _currentWizardInstance.rendered) {
      _currentWizardInstance.bringToTop();
      return _currentWizardInstance;
    }
    // Create a new wizard and track it globally.
    const wizard = new SetupWizardDialog(client);
    _currentWizardInstance = wizard;
    wizard.render(true);
    return wizard;
  }

  // ---------------------------------------------------------------------------
  // get title()
  // ---------------------------------------------------------------------------
  // Localized dynamic title — shown in the dialog header.
  // ---------------------------------------------------------------------------
  get title() {
    return game.i18n.localize("GMHUB.Dialog.SetupWizard.Title");
  }

  // ---------------------------------------------------------------------------
  // getData()
  // ---------------------------------------------------------------------------
  // Return template data. Includes step visibility flags, step data, and
  // any error/status messages.
  // ---------------------------------------------------------------------------
  getData() {
    return {
      // Step visibility: only one step is active at a time.
      step1Visible: this.currentStep === 1,
      step2Visible: this.currentStep === 2,
      step3Visible: this.currentStep === 3,
      // Progress indicator text (e.g., "Step 1 of 3").
      currentStepNumber: this.currentStep,
      totalSteps: 3,
      progressLabel: game.i18n.format("GMHUB.Dialog.SetupWizard.ProgressLabel", {
        current: this.currentStep,
        total: 3
      }),
      // Step 1 data: token input field and ping status.
      step1Token: this.stepData.step1.token,
      step1ValidatedPrincipal: this.stepData.step1.validatedPrincipal,
      step1TokenLabel: game.i18n.localize("GMHUB.Dialog.SetupWizard.Step1TokenLabel"),
      step1Description: game.i18n.localize("GMHUB.Dialog.SetupWizard.Step1Description"),
      step1PingButtonLabel: game.i18n.localize("GMHUB.Dialog.SetupWizard.Step1PingButtonLabel"),
      // Step 2 data: campaign list and selection.
      step2Campaigns: this.stepData.step2.campaigns,
      step2SelectedCampaignId: this.stepData.step2.campaignId,
      step2CampaignSummary: this.stepData.step2.campaignSummary,
      step2Description: game.i18n.localize("GMHUB.Dialog.SetupWizard.Step2Description"),
      step2CampaignLabel: game.i18n.localize("GMHUB.Dialog.SetupWizard.Step2CampaignLabel"),
      step2NoCampaigns: game.i18n.localize("GMHUB.Dialog.SetupWizard.Step2NoCampaigns"),
      // Step 3 data: player mapping (optional).
      step3Description: game.i18n.localize("GMHUB.Dialog.SetupWizard.Step3Description"),
      step3SkipLabel: game.i18n.localize("GMHUB.Dialog.SetupWizard.Step3SkipLabel"),
      step3ConfigureLabel: game.i18n.localize("GMHUB.Dialog.SetupWizard.Step3ConfigureLabel"),
      // Button visibility: Previous/Next/Skip/Finish.
      canGoPrevious: this.currentStep > 1,
      canGoNext: this.currentStep < 3 && this._canAdvanceFromStep(this.currentStep),
      step3Reached: this.currentStep === 3,
      // Busy state: disable buttons during async operations.
      isBusy: this.isBusy
    };
  }

  // ---------------------------------------------------------------------------
  // _canAdvanceFromStep(step)
  // ---------------------------------------------------------------------------
  // Determine if the user can advance from the given step. Returns true
  // iff the step's required data has been validated.
  // ---------------------------------------------------------------------------
  _canAdvanceFromStep(step) {
    switch (step) {
      case 1:
        // Step 1: can advance iff token has been validated (ping succeeded).
        return !!this.stepData.step1.validatedPrincipal;
      case 2:
        // Step 2: can advance iff a campaign has been selected.
        return !!this.stepData.step2.campaignId;
      default:
        return false;
    }
  }

  // ---------------------------------------------------------------------------
  // goToStep(stepNumber)
  // ---------------------------------------------------------------------------
  // Transition to a new step. If entering Step 2, fetch the campaigns list.
  // If entering Step 3, no extra work needed. Triggers a re-render.
  // ---------------------------------------------------------------------------
  async goToStep(stepNumber) {
    if (stepNumber === this.currentStep) return;
    this.currentStep = stepNumber;
    // On entering Step 2, populate campaigns if empty.
    if (stepNumber === 2 && this.stepData.step2.campaigns.length === 0) {
      this.isBusy = true;
      this.render(false);
      try {
        const campaigns = await safeCall(() => this.client.listCampaigns());
        this.stepData.step2.campaigns = campaigns || [];
        if (this.stepData.step2.campaigns.length === 0) {
          ui.notifications.warn(game.i18n.localize("GMHUB.Dialog.SetupWizard.Step2NoCampaigns"));
        }
      } catch (err) {
        // safeCall already toasted the error; re-throw so we can show it inline.
        throw err;
      } finally {
        this.isBusy = false;
        this.render(false);
      }
    } else {
      this.render(false);
    }
  }

  // ---------------------------------------------------------------------------
  // activateListeners(html)
  // ---------------------------------------------------------------------------
  // Wire up button clicks and input change handlers.
  // ---------------------------------------------------------------------------
  activateListeners(html) {
    super.activateListeners(html);

    // Previous button: go back one step (only from steps 2 and 3).
    html.find('[data-action="previous"]').on("click", async () => {
      try {
        await this.goToStep(this.currentStep - 1);
      } catch (err) {
        // Error already toasted by safeCall.
      }
    });

    // Next button: validate current step and advance (only from steps 1 and 2).
    html.find('[data-action="next"]').on("click", async () => {
      try {
        if (this.currentStep === 1) {
          // Step 1 → 2: token must be validated already.
          if (!this._canAdvanceFromStep(1)) return;
          await this.goToStep(2);
        } else if (this.currentStep === 2) {
          // Step 2 → 3: campaign must be selected already.
          if (!this._canAdvanceFromStep(2)) return;
          await this.goToStep(3);
        }
      } catch (err) {
        // Error already toasted.
      }
    });

    // Step 1: Test Connection button (validates the token).
    html.find('[data-action="test-connection"]').on("click", async () => {
      const token = html.find('input[name="step1-token"]').val()?.trim() || "";
      if (!token) {
        ui.notifications.warn(game.i18n.localize("GMHUB.Dialog.SetupWizard.Step1TokenRequired"));
        return;
      }
      this.isBusy = true;
      this.render(false);
      try {
        const principal = await safeCall(() => this.client.ping(token));
        this.stepData.step1.token = token;
        this.stepData.step1.validatedPrincipal = principal;
        this.dirty = true;
        ui.notifications.info(game.i18n.localize("GMHUB.Dialog.SetupWizard.Step1PingSuccess"));
        // Auto-advance to Step 2 on successful validation.
        this.isBusy = false;
        await this.goToStep(2);
      } catch (err) {
        // Error already toasted.
        this.isBusy = false;
      }
    });

    // Track dirty flag on token input change.
    html.find('input[name="step1-token"]').on("change", () => {
      this.dirty = true;
    });

    // Step 2: Campaign selection (radio buttons).
    html.find('input[name="step2-campaign"]').on("change", async (evt) => {
      const campaignId = evt.currentTarget.value;
      if (!campaignId) return;
      this.isBusy = true;
      this.render(false);
      try {
        const campaign = await safeCall(() => this.client.getCampaign(campaignId));
        this.stepData.step2.campaignId = campaignId;
        this.stepData.step2.campaignSummary = campaign;
        this.dirty = true;
        this.render(false);
      } catch (err) {
        // Error already toasted; don't select the campaign.
      } finally {
        this.isBusy = false;
      }
    });

    // Step 3: Skip button (proceed without player mapping).
    html.find('[data-action="skip-mapping"]').on("click", async () => {
      // Direct to _finalize without opening PlayerMapDialog.
      await this._finalize();
    });

    // Step 3: Configure player mapping (opens the PlayerMapDialog).
    html.find('[data-action="configure-mapping"]').on("click", async () => {
      const campaignId = this.stepData.step2.campaignId;
      if (!campaignId) return;
      // Import PlayerMapDialog here to avoid circular deps.
      const { PlayerMapDialog } = await import("./ui.js");
      const dialog = new PlayerMapDialog(campaignId, {
        onSubmit: (playerMap) => {
          this.stepData.step3.playerMap = playerMap;
          this.dirty = true;
          this.render(false);
        }
      });
      dialog.render(true);
    });

    // Finish button (from step 3 only).
    html.find('[data-action="finish"]').on("click", async () => {
      await this._finalize();
    });

    // Input/select change tracking for dirty flag.
    html.find('input, select, textarea').on("change", () => {
      this.dirty = true;
    });
  }

  // ---------------------------------------------------------------------------
  // _finalize()
  // ---------------------------------------------------------------------------
  // Atomically write all accumulated stepData to world settings. If any
  // call fails, no settings are written. On success, shows a toast and
  // closes the dialog.
  // ---------------------------------------------------------------------------
  async _finalize() {
    if (!this.stepData.step1.token || !this.stepData.step2.campaignId) {
      ui.notifications.error(game.i18n.localize("GMHUB.Dialog.SetupWizard.IncompleteConfiguration"));
      return;
    }
    this.isBusy = true;
    this.render(false);
    try {
      // Write all settings in one try block so a failure leaves everything
      // unchanged (no partial writes).
      await game.settings.set(MODULE_ID, "apiKey", this.stepData.step1.token);
      await game.settings.set(MODULE_ID, "campaignId", this.stepData.step2.campaignId);
      if (this.stepData.step3.playerMap) {
        await game.settings.set(MODULE_ID, "playerMap", this.stepData.step3.playerMap);
      }
      // Success: show toast and close the dialog.
      ui.notifications.info(game.i18n.localize("GMHUB.Dialog.SetupWizard.Success"));
      this.dirty = false;
      this.close({ force: true });
    } catch (err) {
      ui.notifications.error(game.i18n.localize("GMHUB.Error.Generic", {
        message: err?.message ?? "unknown"
      }));
    } finally {
      this.isBusy = false;
    }
  }

  // ---------------------------------------------------------------------------
  // close(options)
  // ---------------------------------------------------------------------------
  // Override close to check for unsaved changes. If dirty and not forced,
  // pop a confirm dialog asking Save, Discard, or Cancel.
  // ---------------------------------------------------------------------------
  async close(options = {}) {
    // If forced or not dirty, close immediately.
    if (options.force || !this.dirty) {
      // Clear the global reference on close.
      _currentWizardInstance = null;
      return super.close(options);
    }
    // Unsaved changes: pop a confirm dialog.
    return new Promise((resolve) => {
      const dialog = new Dialog({
        title: game.i18n.localize("GMHUB.Dialog.SetupWizard.UnsavedChangesTitle"),
        content: game.i18n.localize("GMHUB.Dialog.SetupWizard.UnsavedChangesBody"),
        buttons: {
          saveAndClose: {
            label: game.i18n.localize("GMHUB.Dialog.SetupWizard.SaveAndClose"),
            callback: async () => {
              await this._finalize();
              resolve();
            }
          },
          discard: {
            label: game.i18n.localize("GMHUB.Dialog.SetupWizard.Discard"),
            callback: async () => {
              _currentWizardInstance = null;
              await super.close({ force: true });
              resolve();
            }
          },
          cancel: {
            label: game.i18n.localize("GMHUB.Dialog.SetupWizard.Cancel"),
            callback: () => resolve()
          }
        }
      });
      dialog.render(true);
    });
  }
}

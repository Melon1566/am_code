import type { ProviderDriverKind } from "@t3tools/contracts";

export type WizardNavigation =
  | { readonly kind: "navigate"; readonly step: number }
  | { readonly kind: "blocked"; readonly step: number; readonly error: string };

const IDENTITY_STEP = 1;

export const ADD_PROVIDER_WIZARD_STEPS = ["Driver", "Identity", "Config"] as const;
export const CONFIG_STEP = 2;
export const SIGN_IN_STEP_LABEL = "Sign in";

/** Codex can sign in from inside the wizard once the instance exists. */
export function addProviderWizardSteps(driver: ProviderDriverKind): readonly string[] {
  return driver === "codex"
    ? [...ADD_PROVIDER_WIZARD_STEPS, SIGN_IN_STEP_LABEL]
    : ADD_PROVIDER_WIZARD_STEPS;
}

/**
 * Resolve navigation within the add-provider wizard.
 *
 * Moving forward past Identity requires a valid instance id, whether the user
 * advances one step at a time or skips directly to Config from a step header.
 * A blocked skip lands on Identity so its existing inline validation is
 * visible. Backward navigation is always preserved, except once the instance
 * has been created (`locked`): the earlier steps no longer apply to anything.
 */
export function resolveWizardNavigation(
  currentStep: number,
  requestedStep: number,
  stepCount: number,
  validation: { readonly instanceIdError: string | null; readonly locked?: boolean },
): WizardNavigation {
  if (validation.locked === true) {
    return { kind: "navigate", step: currentStep };
  }
  const lastStep = Math.max(0, stepCount - 1);
  const targetStep = Math.max(0, Math.min(lastStep, requestedStep));
  const movesForwardPastIdentity = currentStep <= IDENTITY_STEP && targetStep > IDENTITY_STEP;

  if (movesForwardPastIdentity && validation.instanceIdError !== null) {
    return {
      kind: "blocked",
      step: Math.min(IDENTITY_STEP, lastStep),
      error: validation.instanceIdError,
    };
  }

  return { kind: "navigate", step: targetStep };
}

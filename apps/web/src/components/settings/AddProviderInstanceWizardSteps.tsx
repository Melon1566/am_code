import { WizardSteps } from "../ui/wizard";
import { resolveWizardNavigation, type WizardNavigation } from "./AddProviderInstanceDialog.logic";

interface AddProviderInstanceWizardStepsProps {
  readonly steps: readonly string[];
  readonly currentStep: number;
  readonly summaries: readonly (string | null)[];
  readonly instanceIdError: string | null;
  /** True once the instance exists; earlier steps can no longer be revisited. */
  readonly locked: boolean;
  readonly onNavigation: (navigation: WizardNavigation) => void;
}

export function AddProviderInstanceWizardSteps({
  steps,
  currentStep,
  summaries,
  instanceIdError,
  locked,
  onNavigation,
}: AddProviderInstanceWizardStepsProps) {
  return (
    <WizardSteps
      steps={steps}
      currentStep={currentStep}
      summaries={summaries}
      onStepChange={(requestedStep) =>
        onNavigation(
          resolveWizardNavigation(currentStep, requestedStep, steps.length, {
            instanceIdError,
            locked,
          }),
        )
      }
    />
  );
}

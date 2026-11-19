import { sha256Hex } from "./adapters";
import { canonicalJson } from "./http";

// SHA-256 of the canonical JSON of what an approval binds: the final step and
// its exact inputs. A proposal, its bearer link and its device approval
// request all carry this value.
export const inputsHash = (finalStepKind: string | null, finalStep: string | null, inputs: unknown) =>
  sha256Hex(canonicalJson({ final_step_kind: finalStepKind, final_step: finalStep, inputs }));

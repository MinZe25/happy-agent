/** How a person signs each native assistant in again for the operating-system user running it. */
export const NATIVE_SIGN_IN = {
    claude: { product: "Claude Code", command: "claude auth login" },
    codex: { product: "Codex", command: "codex login" },
    grok: { product: "Grok", command: "grok login" },
} as const;

export type NativeSignInVendor = keyof typeof NATIVE_SIGN_IN;

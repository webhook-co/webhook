/**
 * The max length for an editable display name — shared by the client field and the server action so the two
 * never drift. Deliberately generous: it must not lock a user out of editing a name they ALREADY have
 * (onboarding stores composites up to ~161 chars, and OAuth-provider names are uncapped). The action therefore
 * only rejects a name that is BOTH over this length AND longer than the user's current one — you can always
 * keep or shorten what you have; only new growth beyond this is capped.
 */
export const MAX_DISPLAY_NAME_LEN = 200;

/**
 * TypeSafe's Jev (https://docs.typesafe.ai): a fast classifier that answers typed questions about a `state` with
 * calibrated probabilities. lofiwave uses it for small decisions where code alone can't tell, such as which of five
 * `index.ts` files Claude meant (see src/chat/resolve.ts). It never generates text.
 *
 * Off unless TYPESAFE_API_KEY is set; callers fall back to what code can decide on its own.
 */

export type Choice = { type: "choice"; instructions: unknown; criteria: Record<string, unknown> };
export type Noul = { type: "noul"; instructions: unknown; criteria?: { true: unknown; false: unknown } };
export type Question = Choice | Noul;

export type ChoiceAnswer = { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> };
export type NoulAnswer = { type: "noul"; noul: number };
export type Answer = ChoiceAnswer | NoulAnswer;

/** Ask questions about `state`; answers come back under the same ids. Throws on failure (callers fail closed). */
export type JevAsk = (state: unknown, questions: Record<string, Question>) => Promise<Record<string, Answer>>;

const ENDPOINT = process.env.TYPESAFE_ENDPOINT?.trim() || "https://api.typesafe.ai/v1/systemone";
const MODEL = process.env.JEV_MODEL?.trim() || "jev-latest";
const TIMEOUT_MS = 5000;

export const jevKey = () => process.env.TYPESAFE_API_KEY?.trim() || "";

/** The live client, or null without a key. One retry on 429/529 (rate limited, overloaded). */
export function jevClient(key = jevKey()): JevAsk | null {
  if (!key) return null;
  return async (state, questions) => {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ model: MODEL, state, questions }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if ((res.status === 429 || res.status === 529) && attempt === 0) { await Bun.sleep(300); continue; }
      if (!res.ok) throw new Error(`jev: HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return ((await res.json()) as { answers: Record<string, Answer> }).answers;
    }
  };
}

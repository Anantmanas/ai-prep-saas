import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const GATEWAY_URL = "https://openrouter.ai/api/v1/chat/completions";
// ✅ FIXED: Using OpenRouter's actual high-performance free models router to bypass credit balance locks
const MODEL = "openrouter/free";

export function optimizeTextForTokens(text: string): string {
  if (!text) return "";
  
  // 1. Remove contact details (emails, phone numbers, website links, physical addresses)
  let clean = text
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, "") // email
    .replace(/\+?\d{1,4}[-.\s]?\(?\d{1,3}\)?[-.\s]?\d{1,4}[-.\s]?\d{1,4}[-.\s]?\d{1,9}/g, "") // phone
    .replace(/https?:\/\/\S+/g, "") // URLs
    .replace(/www\.\S+/g, "");

  // 2. Remove common layout symbols, bullet points, and markdown dividers
  clean = clean.replace(/[•▪♦*#\-_+=|\\/]/g, " ");

  // 3. Remove excessive whitespace, newlines, and tabs
  clean = clean.replace(/\s+/g, " ").trim();

  // 4. Token-optimization: Remove common stop words (case-insensitive) to retain core nouns, verbs, and tech skills
  const stopWords = new Set([
    "a", "about", "above", "after", "again", "against", "all", "am", "an", "and", "any", "are", "as", 
    "at", "be", "because", "been", "before", "being", "below", "between", "both", "but", "by", 
    "do", "does", "doing", "down", "during", "each", "few", "for", "from", "further", "had", 
    "has", "have", "having", "he", "her", "here", "hers", "him", "his", "how", "i", "if", "in", 
    "into", "is", "it", "its", "me", "more", "most", "my", "no", "nor", "not", "of", "off", "on", 
    "once", "only", "or", "other", "our", "ours", "out", "over", "own", "same", "she", "should", 
    "so", "some", "such", "than", "that", "the", "their", "theirs", "them", "then", "there", 
    "these", "they", "this", "those", "through", "to", "too", "under", "until", "up", "very", 
    "was", "we", "were", "what", "when", "where", "which", "while", "who", "whom", "why", "with", 
    "you", "your", "yours"
  ]);

  const words = clean.split(" ");
  const filteredWords = words.filter(word => {
    const lowercase = word.toLowerCase().replace(/[^a-z0-9]/g, "");
    return lowercase.length > 0 && !stopWords.has(lowercase);
  });

  // Re-assemble filtered words
  let optimized = filteredWords.join(" ");

  // 5. Hard limit to 1500 characters (extremely token-optimized, retaining high-signal content)
  if (optimized.length > 1500) {
    optimized = optimized.slice(0, 1500) + "...";
  }

  return optimized;
}

class SimpleRateLimiter {
  private queue: (() => void)[] = [];
  private activeCount = 0;
  private lastRequestTime = 0;
  private minIntervalMs = 4000; // Force 4 seconds spacing between any two API requests
  private maxConcurrent = 1; // Sequential execution to prevent provider rate drops

  async acquire(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
      this.processQueue();
    });
  }

  release() {
    this.activeCount--;
    this.processQueue();
  }

  private processQueue() {
    if (this.queue.length === 0) return;
    if (this.activeCount >= this.maxConcurrent) return;

    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    const timeToWait = Math.max(0, this.minIntervalMs - elapsed);

    if (timeToWait > 0) {
      setTimeout(() => this.processQueue(), timeToWait);
      return;
    }

    const next = this.queue.shift();
    if (next) {
      this.activeCount++;
      this.lastRequestTime = Date.now();
      next();
    }
  }
}

const apiRateLimiter = new SimpleRateLimiter();

async function callGemini(system: string, user: string): Promise<string> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("MISSING_KEY");

  await apiRateLimiter.acquire();

  let attempt = 0;
  const maxAttempts = 3;
  let lastError: any = null;

  try {
    while (attempt < maxAttempts) {
      try {
        const res = await fetch(GATEWAY_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${key}`,
            "HTTP-Referer": "http://localhost:3000",
            "X-Title": "InterviewAI",
          },
          body: JSON.stringify({
            model: MODEL,
            messages: [
              { role: "system", content: system },
              { role: "user", content: user },
            ],
            response_format: { type: "json_object" },
          }),
        });

        if (!res.ok) {
          const text = await res.text().catch(() => "");
          if (res.status === 429) {
            console.warn(`Rate limited (429). Retrying in ${(attempt + 1) * 2000}ms...`);
            await new Promise((r) => setTimeout(r, (attempt + 1) * 2000));
            attempt++;
            continue;
          }
          if (res.status === 402) throw new Error("CREDITS_EXHAUSTED");
          throw new Error(`AI_ERROR:${res.status}:${text.slice(0, 200)}`);
        }

        const data = await res.json();
        return data.choices?.[0]?.message?.content ?? "";
      } catch (err: any) {
        lastError = err;
        if (err.message === "CREDITS_EXHAUSTED" || err.message.startsWith("AI_ERROR")) {
          throw err;
        }
        console.warn(`Request failed: ${err.message}. Retrying in ${(attempt + 1) * 2000}ms...`);
        await new Promise((r) => setTimeout(r, (attempt + 1) * 2000));
        attempt++;
      }
    }
    throw lastError || new Error("MAX_RETRIES_EXCEEDED");
  } finally {
    apiRateLimiter.release();
  }
}

function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    // Strip markdown code blocks/fences if the model forces them into its string output
    const cleaned = raw.replace(/```json|```/g, "").trim();
    try {
      return JSON.parse(cleaned) as T;
    } catch {
      return fallback;
    }
  }
}

const GenerateInput = z.object({
  type: z.string(),
  difficulty: z.string(),
  resumeContext: z.string().optional().default(""),
});

export const generateQuestions = createServerFn({ method: "POST" })
  .validator((input: unknown) => GenerateInput.parse(input))
  .handler(async ({ data }) => {
    const system = `You are an expert technical interviewer. Generate 5 targeted interview questions.
Return STRICTLY valid JSON in this exact shape:
{ "questions": ["q1", "q2", "q3", "q4", "q5"] }
No commentary. No markdown. JSON only.`;

    const optimizedResume = data.resumeContext ? optimizeTextForTokens(data.resumeContext) : "";

    const user = `Interview Type: ${data.type}
Difficulty: ${data.difficulty}
${
  optimizedResume
    ? `Candidate Resume Context (Token-Optimized):
${optimizedResume}

CRITICAL: Since a resume is provided, you MUST tailor all 5 questions directly to the candidate's specific background, projects, work history, and skills listed in the resume. The questions should test them on their actual experience in the context of a ${data.difficulty} ${data.type} interview.`
    : `No resume provided — generate general questions for a ${data.difficulty}-level ${data.type} interview.`
}

Return 5 concise, high-quality questions tailored to the type, difficulty, and (if provided) resume. Questions must be specific, interviewer-grade, and deeply relevant to the candidate's background if the resume is present.`;

    try {
      const raw = await callGemini(system, user);
      const parsed = safeJsonParse<{ questions: string[] }>(raw, { questions: [] });
      let qs = Array.isArray(parsed.questions) ? parsed.questions.filter((q) => typeof q === "string") : [];

      if (qs.length < 5) {
        // High-quality local code-fallback dataset if API drops out or limits out mid-session
        const fallbacks = [
          `Walk me through a challenging ${data.type.toLowerCase()} problem you've solved recently.`,
          `How do you approach assessing architecture bottlenecks under a ${data.difficulty.toLowerCase()}-level engineering context?`,
          `Describe your precise diagnostic workflow when investigating erratic production failures.`,
          `Tell me about a time you had to pivot and master an entirely foreign tech framework within tight deadlines.`,
          `What are your fundamental engineering principles that apply to this targeted ${data.type} landscape?`,
        ];
        qs = [...qs, ...fallbacks].slice(0, 5);
      }
      return { questions: qs.slice(0, 5) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "UNKNOWN";
      return { questions: [] as string[], error: msg };
    }
  });

const EvaluateInput = z.object({
  question: z.string(),
  answer: z.string(),
  type: z.string(),
  difficulty: z.string(),
});

export const evaluateAnswer = createServerFn({ method: "POST" })
  .validator((input: unknown) => EvaluateInput.parse(input))
  .handler(async ({ data }) => {
    const system = `You are a strict but fair senior interviewer coach.
Evaluate the candidate's answer and return STRICTLY valid JSON in this exact shape:
{ "score": <integer 1-10>, "feedback": "<2-4 sentences of actionable improvements>", "ideal_answer": "<a strong sample answer, 3-6 sentences>" }
No commentary. No markdown. JSON only.`;

    const user = `Interview Type: ${data.type}
Difficulty: ${data.difficulty}

Question:
${data.question}

Candidate Answer:
${data.answer || "(no answer provided)"}

Evaluate rigor, correctness, clarity, structure. Score honestly.`;

    const fallback = {
      score: 5,
      feedback: "The response metric system dropped into local fallback mode. Consider framing your answer explicitly with clear business problem scopes, targeted implementation steps, and concrete engineering trade-offs.",
      ideal_answer: "A gold-standard response structure maps out the context cleanly using the STAR methodology (Situation, Task, Action, Result), introduces direct technical solutions applied, and weighs architectural alternative selections explicitly.",
    };

    try {
      const raw = await callGemini(system, user);
      const parsed = safeJsonParse<typeof fallback>(raw, fallback);
      const score = Math.max(1, Math.min(10, Number(parsed.score) || fallback.score));
      return {
        score,
        feedback: typeof parsed.feedback === "string" ? parsed.feedback : fallback.feedback,
        ideal_answer: typeof parsed.ideal_answer === "string" ? parsed.ideal_answer : fallback.ideal_answer,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "UNKNOWN";
      return { ...fallback, error: msg };
    }
  });

export const checkAiKey = createServerFn({ method: "GET" }).handler(async () => {
  // ✅ FIXED: Aligned check verification to cross-check the correct runtime state value
  return { hasKey: !!process.env.GEMINI_API_KEY };
});
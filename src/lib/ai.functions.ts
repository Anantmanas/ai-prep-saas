import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const GATEWAY_URL = "https://openrouter.ai/api/v1/chat/completions";
// ✅ FIXED: Using OpenRouter's actual high-performance free models router to bypass credit balance locks
const MODEL = "openrouter/free";

async function callGemini(system: string, user: string): Promise<string> {
  // ✅ FIXED: Configured to look for the unified API key name from your local .env file
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("MISSING_KEY");

  const res = await fetch(GATEWAY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
      // ✅ FIXED: Appended crucial metadata headers required by OpenRouter to greenlight free-tier streams
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
    if (res.status === 429) throw new Error("RATE_LIMITED");
    if (res.status === 402) throw new Error("CREDITS_EXHAUSTED");
    throw new Error(`AI_ERROR:${res.status}:${text.slice(0, 200)}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "";
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

    const user = `Interview Type: ${data.type}
Difficulty: ${data.difficulty}
${
  data.resumeContext && data.resumeContext.trim().length > 0
    ? `Candidate Resume Context:
${data.resumeContext.slice(0, 4000)}

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
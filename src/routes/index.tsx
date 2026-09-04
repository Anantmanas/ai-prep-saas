import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useRef, useState } from "react";
import Editor from "@monaco-editor/react";
import {
  Brain,
  Sparkles,
  Timer,
  Mic,
  MicOff,
  Upload,
  Code2,
  FileText,
  ChevronRight,
  RotateCcw,
  Trophy,
  AlertTriangle,
  Send,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import { generateQuestions, evaluateAnswer, checkAiKey } from "@/lib/ai.functions";
import { toast } from "sonner";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "InterviewAI — Practice interviews with a live AI coach" },
      {
        name: "description",
        content:
          "Bento-style AI interview simulator with resume-tailored questions, live coaching, voice input, and Monaco code editor. Lightweight, fast, and free.",
      },
      { property: "og:title", content: "InterviewAI — Live AI Interview Coach" },
      {
        property: "og:description",
        content:
          "Resume-tailored questions, real-time scoring, voice + code editor. Practice technical, behavioral, and system design interviews.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: InterviewSimulator,
});

type Phase = "SETUP" | "FETCHING" | "ACTIVE" | "REPORT";
type Evaluation = { score: number; feedback: string; ideal_answer: string };
type ChatMsg = { role: "user" | "coach"; text: string };

const QUESTION_SECONDS = 180;

function InterviewSimulator() {
  const [phase, setPhase] = useState<Phase>("SETUP");
  const [type, setType] = useState("Technical");
  const [difficulty, setDifficulty] = useState("Mid");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [resumeUploadedText, setResumeUploadedText] = useState("");
  const [resumeName, setResumeName] = useState("");
  const [resumeFile, setResumeFile] = useState<File | null>(null);
  const [pastedText, setPastedText] = useState("");
  const [questions, setQuestions] = useState<string[]>([]);
  const [current, setCurrent] = useState(0);
  const [textAnswer, setTextAnswer] = useState("");
  const [codeAnswer, setCodeAnswer] = useState("");
  const [voiceAnswer, setVoiceAnswer] = useState("");
  const [inputMode, setInputMode] = useState<"text" | "code" | "voice">("text");
  const [codeLanguage, setCodeLanguage] = useState("javascript");
  const [evaluations, setEvaluations] = useState<(Evaluation | null)[]>([]);
  const [evaluating, setEvaluating] = useState(false);
  const [chat, setChat] = useState<ChatMsg[]>([]);
  const [timeLeft, setTimeLeft] = useState(QUESTION_SECONDS);
  const [isRecording, setIsRecording] = useState(false);
  const [aiKeyOk, setAiKeyOk] = useState<boolean | null>(null);

  const genFn = useServerFn(generateQuestions);
  const evalFn = useServerFn(evaluateAnswer);
  const checkKeyFn = useServerFn(checkAiKey);

  const recognitionRef = useRef<any>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const voiceAnswerRef = useRef("");
  const shouldAutoRestartVoiceRef = useRef(false);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastInterimUpdateRef = useRef(0);
  const noSpeechTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
const MAX_RESTART_ATTEMPTS = 3;
const restartAttemptsRef = useRef(0);

  const syncVoiceAnswer = (nextValue: string) => {
    voiceAnswerRef.current = nextValue;
    setVoiceAnswer(nextValue);
  };

  // Debounce interim result updates to reduce re-renders
  const scheduleInterimUpdate = (value: string, delay = 100) => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => {
      syncVoiceAnswer(value);
      lastInterimUpdateRef.current = Date.now();
    }, delay);
  };

  useEffect(() => {
    voiceAnswerRef.current = voiceAnswer;
  }, [voiceAnswer]);

  useEffect(() => {
    checkKeyFn({})
      .then((r) => setAiKeyOk(r.hasKey))
      .catch(() => setAiKeyOk(false));
  }, [checkKeyFn]);

  // Countdown timer
  useEffect(() => {
    if (phase !== "ACTIVE") return;
    setTimeLeft(QUESTION_SECONDS);
    timerRef.current = setInterval(() => {
      setTimeLeft((t) => (t > 0 ? t - 1 : 0));
    }, 1000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [phase, current]);

  // Stop recording when input mode changes or on unmount
  useEffect(() => {
    if (inputMode !== "voice" && isRecording) {
      stopRecognition();
    }
  }, [inputMode, isRecording]);

  useEffect(() => {
    return () => {
      stopRecognition();
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      if (noSpeechTimeoutRef.current) clearTimeout(noSpeechTimeoutRef.current);
    };
  }, []);

  const stopRecognition = () => {
    shouldAutoRestartVoiceRef.current = false;

    // Clean up timers
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    if (noSpeechTimeoutRef.current) clearTimeout(noSpeechTimeoutRef.current);

    if (!recognitionRef.current) {
      setIsRecording(false);
      return;
    }

    const currentRecognition = recognitionRef.current;
    recognitionRef.current = null;

    try {
      currentRecognition.onend = null;
      currentRecognition.stop();
    } catch {
      // Ignore stop errors from already-closed recognizers.
    }

    setIsRecording(false);
  };

  // Web Speech API
  const speechSupported = useMemo(() => {
    if (typeof window === "undefined") return false;
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    const hasSpeechApi = !!SR;
    return hasSpeechApi && !!window.isSecureContext;
  }, []);

  function startRecognition() {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) {
      toast.error("SpeechRecognition API not supported in this browser.");
      return;
    }
    const rec = new SR();
    // Reset restart counter each fresh start
    restartAttemptsRef.current = 0;
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US";
    rec.maxAlternatives = 1;

    let committedTranscript = voiceAnswerRef.current.trim();
    let lastProcessedResultIndex = 0;
    shouldAutoRestartVoiceRef.current = true;

    // Reset no-speech timeout when recognition starts
    if (noSpeechTimeoutRef.current) clearTimeout(noSpeechTimeoutRef.current);
    noSpeechTimeoutRef.current = setTimeout(() => {
      // Auto-restart if no speech detected for 5 seconds during active recording
      if (shouldAutoRestartVoiceRef.current && recognitionRef.current && inputMode === "voice") {
        console.warn("No speech detected, restarting recognition...");
        rec.stop();
      }
    }, 5000);

    rec.onresult = (event: any) => {
      // Reset no-speech timeout on any result
      if (noSpeechTimeoutRef.current) clearTimeout(noSpeechTimeoutRef.current);
      noSpeechTimeoutRef.current = setTimeout(() => {
        if (shouldAutoRestartVoiceRef.current && recognitionRef.current && inputMode === "voice") {
          rec.stop();
        }
      }, 5000);

      let nextFinalText = "";
      let nextInterimText = "";

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const transcript = (result[0]?.transcript ?? "").trim();

        if (!transcript) continue;

        if (result.isFinal) {
          // Always include final results
          nextFinalText = nextFinalText ? `${nextFinalText} ${transcript}` : transcript;
        } else {
          // For interim results, filter out very short ones (noise reduction)
          // Only include if at least 3 characters (confidence filtering)
          if (transcript.length >= 3) {
            nextInterimText = nextInterimText ? `${nextInterimText} ${transcript}` : transcript;
          }
        }
      }

      if (nextFinalText) {
        committedTranscript = [committedTranscript, nextFinalText].filter(Boolean).join(" ").trim();
      }

      if (!nextFinalText && !nextInterimText) return;

      const nextValue = [committedTranscript, nextInterimText].filter(Boolean).join(" ").trim();

      // Debounce interim updates to reduce re-renders (improves performance)
      scheduleInterimUpdate(nextValue, 80);
    };

    rec.onerror = (err: any) => {
      const errorCode = err?.error ?? "unknown-error";

      // Handle no-speech gracefully by restarting instead of erroring
      if (errorCode === "no-speech") {
        if (shouldAutoRestartVoiceRef.current && inputMode === "voice") {
          console.warn("No speech detected, auto-restarting recognition...");
          recognitionRef.current = null;
          // Small delay before restart to avoid immediate re-trigger
          setTimeout(() => {
            if (shouldAutoRestartVoiceRef.current && inputMode === "voice") {
              startRecognition();
            }
          }, 500);
        }
        return;
      }

      if (errorCode === "aborted") {
        return;
      }

      console.error("Speech recognition error:", err);
      toast.error("Voice input hit an error. Please try again.");
      stopRecognition();
    };

    rec.onend = () => {
      if (noSpeechTimeoutRef.current) clearTimeout(noSpeechTimeoutRef.current);

      if (!shouldAutoRestartVoiceRef.current || inputMode !== "voice") {
        setIsRecording(false);
        return;
      }

      recognitionRef.current = null;
      // Smooth restart: add a 200ms delay to capture boundary words
      setTimeout(() => {
        if (shouldAutoRestartVoiceRef.current && inputMode === "voice") {
          startRecognition();
        }
      }, 200);
    };

    try {
      recognitionRef.current = rec;
      rec.start();
      setIsRecording(true);
    } catch {
      console.error("Speech recognition failed to start.");
      toast.error("Voice input couldn't start. Please try again.");
      stopRecognition();
    }
  }

  function toggleRecording() {
    if (!speechSupported) {
      const secureContextNotice =
        typeof window !== "undefined" && !window.isSecureContext
          ? "Voice input requires a secure browser context (HTTPS or localhost)."
          : "Voice input unavailable in this browser — use text or the code editor.";
      toast.info(secureContextNotice);
      return;
    }

    if (isRecording) {
      stopRecognition();
      return;
    }

    startRecognition();
  }

  async function extractTextFromPdf(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      if ((window as any).pdfjsLib) {
        parsePdfData((window as any).pdfjsLib, file)
          .then(resolve)
          .catch(reject);
        return;
      }

      const script = document.createElement("script");
      script.id = "pdfjs-cdn-script";
      script.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.min.js";
      script.onload = async () => {
        const pdfjsLib = (window as any).pdfjsLib;
        pdfjsLib.GlobalWorkerOptions.workerSrc =
          "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.worker.min.js";
        try {
          const text = await parsePdfData(pdfjsLib, file);
          resolve(text);
        } catch (err) {
          reject(err);
        }
      };
      script.onerror = () => reject(new Error("Failed to load PDF parsing library."));
      document.head.appendChild(script);
    });
  }

  async function parsePdfData(pdfjsLib: any, file: File): Promise<string> {
    const arrayBuffer = await file.arrayBuffer();
    const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
    const pdf = await loadingTask.promise;
    let fullText = "";

    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();
      const pageText = textContent.items.map((item: any) => item.str).join(" ");
      fullText += pageText + "\n";
    }
    return fullText;
  }

  async function extractFileText(file: File): Promise<string> {
    let text = "";
    if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
      text = await extractTextFromPdf(file);
    } else {
      text = await file.text();
    }
    return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, " ").slice(0, 8000);
  }

  async function handleResumeFile(file: File) {
    setResumeName(file.name);
    setResumeFile(file);
    try {
      toast.info("Extracting PDF resume text...");
      const cleaned = await extractFileText(file);
      setResumeUploadedText(cleaned);
      toast.success(`Loaded resume: ${file.name}`);
    } catch (err) {
      console.error(err);
      toast.error("Couldn't read resume file. Try a .txt or paste your resume text.");
    }
  }

  async function startInterview() {
    if (!name.trim()) {
      toast.error("Please enter your name.");
      return;
    }
    const emailTrimmed = email.trim();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(emailTrimmed)) {
      toast.error("Please enter a valid email address.");
      return;
    }
    const phoneDigits = phone.replace(/\D/g, "");
    if (phoneDigits.length !== 10) {
      toast.error("Please enter a valid 10-digit mobile number.");
      return;
    }
    if (aiKeyOk === false) {
      toast.error("AI service isn't configured yet.");
      return;
    }

    setPhase("FETCHING");
    try {
      let uploadedResumeUrl: string | null = null;

      if (resumeFile) {
        const fileExt = resumeFile.name.split(".").pop();
        const fileName = `${Date.now()}_resume_${Math.random().toString(36).substring(2, 15)}.${fileExt}`;
        const filePath = `${fileName}`;

        const { data: uploadData, error: uploadError } = await supabase.storage
          .from("resume_collection")
          .upload(filePath, resumeFile);

        if (uploadError) {
          console.error("Storage resume upload error:", uploadError);
        } else if (uploadData) {
          const {
            data: { publicUrl },
          } = supabase.storage.from("resume_collection").getPublicUrl(filePath);
          uploadedResumeUrl = publicUrl;
        }
      }

      // Determine Resume vs. JD based on file upload vs. pasted text
      const hasUploadedResume = !!resumeUploadedText.trim();
      const hasPastedText = !!pastedText.trim();

      let resumeContext = "";
      let jdContext = "";

      if (hasUploadedResume && hasPastedText) {
        resumeContext = resumeUploadedText;
        jdContext = pastedText;
      } else if (hasUploadedResume) {
        resumeContext = resumeUploadedText;
      } else if (hasPastedText) {
        resumeContext = pastedText;
      }

      let combinedResumeText = resumeContext.trim();
      if (jdContext.trim()) {
        combinedResumeText += `\n\n--- JOB DESCRIPTION ---\n${jdContext.trim()}`;
      }

      const formattedPhone = `+91${phoneDigits}`;

      const { error: dbError } = await supabase.from("pre_requisites").insert([
        {
          name: name.trim(),
          email: emailTrimmed,
          phone: formattedPhone,
          interview_type: type,
          difficulty: difficulty,
          resume_text: combinedResumeText || null,
        },
      ]);

      if (dbError) {
        console.error("Failed to save user data to Supabase:", dbError);
      }

      const res = await genFn({
        data: {
          type,
          difficulty,
          resumeContext,
          jdContext,
        },
      });
      if (!res.questions.length) throw new Error(res.error || "No questions");
      setQuestions(res.questions);
      setEvaluations(new Array(res.questions.length).fill(null));
      setCurrent(0);
      setTextAnswer("");
      setCodeAnswer("");
      syncVoiceAnswer("");
      setChat([
        {
          role: "coach",
          text: `Ready! I've generated ${res.questions.length} ${difficulty.toLowerCase()} ${type.toLowerCase()} questions for you. Take a breath — you've got this. 💪`,
        },
      ]);
      setPhase("ACTIVE");
    } catch (err) {
      console.error(err);
      toast.error("Couldn't generate questions. Please try again.");
      setPhase("SETUP");
    }
  }

  async function submitAnswer() {
    const activeAnswer =
      inputMode === "text"
        ? textAnswer
        : inputMode === "code"
          ? codeAnswer
          : voiceAnswerRef.current || voiceAnswer;
    if (!activeAnswer.trim()) {
      toast.info("Type or record an answer first.");
      return;
    }
    if (isRecording) {
      stopRecognition();
    }
    syncVoiceAnswer(activeAnswer);
    setEvaluating(true);
    try {
      const res = await evalFn({
        data: { question: questions[current], answer: activeAnswer, type, difficulty },
      });
      const evalObj: Evaluation = {
        score: res.score,
        feedback: res.feedback,
        ideal_answer: res.ideal_answer,
      };
      setEvaluations((prev) => {
        const next = [...prev];
        next[current] = evalObj;
        return next;
      });
      setChat((prev) => [
        ...prev,
        { role: "user", text: activeAnswer.slice(0, 240) + (activeAnswer.length > 240 ? "…" : "") },
        { role: "coach", text: `Score: ${res.score}/10 — ${res.feedback}` },
      ]);
    } catch (err) {
      console.error(err);
      toast.error("Evaluation failed. Try again.");
    } finally {
      setEvaluating(false);
    }
  }

  function nextQuestion() {
    if (current < questions.length - 1) {
      setCurrent((c) => c + 1);
      setTextAnswer("");
      setCodeAnswer("");
      syncVoiceAnswer("");
    } else {
      setPhase("REPORT");
    }
  }

  function resetAll() {
    setPhase("SETUP");
    setQuestions([]);
    setEvaluations([]);
    setTextAnswer("");
    setCodeAnswer("");
    syncVoiceAnswer("");
    setChat([]);
    setCurrent(0);
    setName("");
    setEmail("");
    setPhone("");
    setResumeUploadedText("");
    setResumeName("");
    setResumeFile(null);
    setPastedText("");
    setInputMode("text");
    setCodeLanguage("javascript");
  }

  const activeAnswer =
    inputMode === "text" ? textAnswer : inputMode === "code" ? codeAnswer : voiceAnswer;
  const mmss = `${String(Math.floor(timeLeft / 60)).padStart(2, "0")}:${String(timeLeft % 60).padStart(2, "0")}`;
  const urgent = timeLeft > 0 && timeLeft < 60;
  const currentEval = evaluations[current];
  const progressPct = questions.length
    ? Math.round(((current + (currentEval ? 1 : 0)) / questions.length) * 100)
    : 0;

  return (
    <div className="min-h-screen">
      {/* Header */}
      <header className="max-w-7xl mx-auto px-6 pt-8 pb-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div
            className="w-10 h-10 rounded-xl flex items-center justify-center"
            style={{ background: "var(--gradient-primary)" }}
          >
            <Brain className="w-5 h-5 text-primary-foreground" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-gradient">InterviewAI</h1>
            <p className="text-xs text-muted-foreground">Your live AI interview coach</p>
          </div>
        </div>
        {phase !== "SETUP" && (
          <Button variant="ghost" size="sm" onClick={resetAll} className="gap-2">
            <RotateCcw className="w-4 h-4" /> New Session
          </Button>
        )}
      </header>

      {aiKeyOk === false && (
        <div className="max-w-7xl mx-auto px-6 mb-2">
          <div className="flex items-start gap-3 rounded-lg border border-warning/40 bg-warning/10 p-4 text-sm">
            <AlertTriangle
              className="w-5 h-5 text-warning shrink-0"
              style={{ color: "var(--warning)" }}
            />
            <div>
              <p className="font-medium">AI service isn't configured yet.</p>
              <p className="text-muted-foreground">
                Please configure your API key in settings to activate AI features.
              </p>
            </div>
          </div>
        </div>
      )}

      <main className="max-w-7xl mx-auto px-6 pb-16">
        {phase === "SETUP" && (
          <SetupView
            type={type}
            setType={setType}
            difficulty={difficulty}
            setDifficulty={setDifficulty}
            name={name}
            setName={setName}
            email={email}
            setEmail={setEmail}
            phone={phone}
            setPhone={setPhone}
            resumeName={resumeName}
            resumeUploadedText={resumeUploadedText}
            pastedText={pastedText}
            setPastedText={setPastedText}
            onResume={handleResumeFile}
            onStart={startInterview}
            disabled={aiKeyOk === false}
          />
        )}

        {phase === "FETCHING" && <FetchingView />}

        {phase === "ACTIVE" && (
          <>
            {/* Progress bar */}
            <div className="mb-6">
              <div className="flex items-center justify-between mb-2 text-sm">
                <span className="text-muted-foreground">
                  Question {current + 1} of {questions.length}
                </span>
                <span className="text-muted-foreground">{progressPct}% complete</span>
              </div>
              <Progress value={progressPct} className="h-2" />
            </div>

            {/* Bento Grid */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
              {/* Col 1: Question + Timer */}
              <div className="lg:col-span-4 flex flex-col gap-5">
                <div className={`bento-card ${urgent ? "timer-urgent" : ""}`}>
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Timer className="w-4 h-4" /> Time remaining
                    </div>
                    <Badge variant="secondary" className="text-xs">
                      {difficulty}
                    </Badge>
                  </div>
                  <div className="text-5xl font-bold tabular-nums tracking-tight">{mmss}</div>
                </div>

                <div className="bento-card flex-1">
                  <div className="flex items-center gap-2 mb-3">
                    <Sparkles className="w-4 h-4 text-primary" />
                    <h3 className="font-semibold">Question {current + 1}</h3>
                  </div>
                  <p className="text-foreground leading-relaxed">{questions[current]}</p>
                </div>

                <div className="bento-card">
                  <div className="flex items-center gap-2 mb-2 text-sm text-muted-foreground">
                    <Brain className="w-4 h-4" /> Candidate Profile
                  </div>
                  <div className="text-xs space-y-1 text-muted-foreground">
                    <div className="font-semibold text-foreground">{name}</div>
                    <div>{email}</div>
                    <div>+91 {phone}</div>
                  </div>
                </div>
              </div>

              {/* Col 2: Answer input */}
              <div className="lg:col-span-5">
                <div className="bento-card h-full flex flex-col">
                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
                    <h3 className="font-semibold flex items-center gap-2 text-sm">
                      {inputMode === "text" && <FileText className="w-4 h-4 text-primary" />}
                      {inputMode === "code" && <Code2 className="w-4 h-4 text-primary" />}
                      {inputMode === "voice" && <Mic className="w-4 h-4 text-primary" />}
                      Your Answer
                    </h3>
                    <div className="flex items-center w-full sm:w-auto bg-muted/40 p-1 rounded-lg border border-border/50 backdrop-blur-sm gap-0.5">
                      <button
                        type="button"
                        onClick={() => setInputMode("text")}
                        className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-md transition-all duration-200 flex-1 sm:flex-none whitespace-nowrap ${inputMode === "text"
                          ? "bg-gradient-to-br from-primary/90 to-primary text-primary-foreground shadow-lg shadow-primary/30 border border-primary/40"
                          : "text-muted-foreground hover:text-foreground hover:bg-muted/60"
                          }`}
                      >
                        <FileText className="w-3.5 h-3.5" />
                        <span className="hidden sm:inline">Text</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setInputMode("code")}
                        className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-md transition-all duration-200 flex-1 sm:flex-none whitespace-nowrap ${inputMode === "code"
                          ? "bg-gradient-to-br from-primary/90 to-primary text-primary-foreground shadow-lg shadow-primary/30 border border-primary/40"
                          : "text-muted-foreground hover:text-foreground hover:bg-muted/60"
                          }`}
                      >
                        <Code2 className="w-3.5 h-3.5" />
                        <span className="hidden sm:inline">Code</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setInputMode("voice")}
                        className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-md transition-all duration-200 flex-1 sm:flex-none whitespace-nowrap ${inputMode === "voice"
                          ? "bg-gradient-to-br from-primary/90 to-primary text-primary-foreground shadow-lg shadow-primary/30 border border-primary/40"
                          : "text-muted-foreground hover:text-foreground hover:bg-muted/60"
                          }`}
                      >
                        <Mic className="w-3.5 h-3.5" />
                        <span className="hidden sm:inline">Voice</span>
                      </button>
                    </div>
                  </div>

                  {inputMode === "code" && (
                    <div className="flex items-center justify-between gap-3 mb-3 px-0.5">
                      <span className="text-xs text-muted-foreground font-medium">Language:</span>
                      <Select value={codeLanguage} onValueChange={setCodeLanguage}>
                        <SelectTrigger className="h-8 w-[140px] text-xs bg-gradient-to-r from-muted/60 to-muted/40 border border-primary/20 hover:border-primary/40 transition-all duration-200 focus:border-primary/60 focus:ring-primary/20">
                          <SelectValue placeholder="Language" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="javascript">JavaScript</SelectItem>
                          <SelectItem value="typescript">TypeScript</SelectItem>
                          <SelectItem value="python">Python</SelectItem>
                          <SelectItem value="java">Java</SelectItem>
                          <SelectItem value="cpp">C++</SelectItem>
                          <SelectItem value="go">Go</SelectItem>
                          <SelectItem value="rust">Rust</SelectItem>
                          <SelectItem value="html">HTML</SelectItem>
                          <SelectItem value="css">CSS</SelectItem>
                          <SelectItem value="sql">SQL</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  )}

                  {inputMode === "code" && (
                    <div className="flex-1 min-h-[320px] rounded-lg overflow-hidden border border-primary/20 bg-gradient-to-br from-muted/40 to-muted/20 shadow-md hover:border-primary/40 transition-all duration-300 backdrop-blur-sm">
                      <Editor
                        height="100%"
                        language={codeLanguage}
                        theme="vs-dark"
                        value={codeAnswer}
                        onChange={(v) => setCodeAnswer(v ?? "")}
                        options={{
                          minimap: { enabled: false },
                          fontSize: 13,
                          scrollBeyondLastLine: false,
                          wordWrap: "on",
                          padding: { top: 12, bottom: 12 },
                          renderLineHighlight: "gutter",
                          smoothScrolling: true,
                          cursorBlinking: "blink",
                        }}
                      />
                    </div>
                  )}

                  {inputMode === "text" && (
                    <Textarea
                      value={textAnswer}
                      onChange={(e) => setTextAnswer(e.target.value)}
                      placeholder="Structure your answer: context → approach → trade-offs → outcome…"
                      className="flex-1 min-h-[320px] resize-none font-mono text-sm bg-gradient-to-br from-input/50 to-muted/30 border border-primary/20 hover:border-primary/40 transition-all duration-300 focus:border-primary/60 focus:ring-primary/20 rounded-lg backdrop-blur-sm"
                    />
                  )}

                  {inputMode === "voice" && (
                    <div className="flex-1 flex flex-col justify-between min-h-[320px] p-6 rounded-lg border border-border bg-muted/20 relative overflow-hidden">
                      {/* Decorative backdrop glow */}
                      <div
                        className="absolute inset-0 pointer-events-none"
                        style={{
                          backgroundImage:
                            "radial-gradient(circle, oklch(0.72 0.18 200 / 0.15) 0%, transparent 70%)",
                        }}
                      />

                      <div className="flex-1 flex flex-col items-center justify-center py-4 z-10">
                        {/* Audio activity visualizer circles */}
                        <div className="relative flex items-center justify-center w-28 h-28 mb-4">
                          {isRecording && (
                            <>
                              <div
                                className="absolute inset-0 rounded-full bg-destructive/20 voice-pulse-ring"
                                style={{ animationDelay: "0s" }}
                              />
                              <div
                                className="absolute inset-0 rounded-full bg-destructive/15 voice-pulse-ring"
                                style={{ animationDelay: "0.6s" }}
                              />
                              <div
                                className="absolute inset-0 rounded-full bg-destructive/5 voice-pulse-ring"
                                style={{ animationDelay: "1.2s" }}
                              />
                            </>
                          )}
                          <Button
                            type="button"
                            onClick={toggleRecording}
                            className={`w-20 h-20 rounded-full flex items-center justify-center shadow-lg transition-all transform active:scale-95 duration-300 ${isRecording
                              ? "bg-destructive hover:bg-destructive/90 text-white animate-pulse"
                              : "bg-primary hover:bg-primary/90 text-primary-foreground"
                              }`}
                            disabled={!speechSupported}
                            title={speechSupported ? "" : "Voice input unavailable"}
                          >
                            {isRecording ? (
                              <MicOff className="w-8 h-8" />
                            ) : (
                              <Mic className="w-8 h-8" />
                            )}
                          </Button>
                        </div>

                        <div className="text-center space-y-1">
                          <p className="font-semibold text-sm">
                            {isRecording ? "Listening..." : "Click to Speak"}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {isRecording
                              ? "Transcribing in real-time. Click to stop."
                              : "Use voice dictation to construct your answer."}
                          </p>
                        </div>
                      </div>

                      {/* Transcribed Text Preview */}
                      <div className="z-10 space-y-2 mt-4 pt-4 border-t border-primary/20">
                        <label className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">
                          Transcript Preview
                        </label>
                        <Textarea
                          value={voiceAnswer}
                          onChange={(e) => {
                            const nextValue = e.target.value;
                            syncVoiceAnswer(nextValue);
                          }}
                          placeholder="Your spoken answer will appear here. You can also edit it directly…"
                          className="w-full h-24 resize-none font-mono text-xs bg-gradient-to-br from-input/40 to-muted/20 border border-primary/20 hover:border-primary/40 transition-all duration-300 focus:border-primary/60 focus:ring-primary/20 rounded-lg backdrop-blur-sm"
                        />
                      </div>
                    </div>
                  )}

                  <div className="flex items-center justify-between mt-4">
                    <span className="text-xs text-muted-foreground">
                      {activeAnswer.length} chars {isRecording && "• 🔴 listening"}
                    </span>
                    {currentEval ? (
                      <Button onClick={nextQuestion} className="btn-hero gap-1">
                        {current < questions.length - 1 ? "Next Question" : "See Report"}
                        <ChevronRight className="w-4 h-4" />
                      </Button>
                    ) : (
                      <Button
                        onClick={submitAnswer}
                        disabled={evaluating || !activeAnswer.trim()}
                        className="btn-hero gap-1"
                      >
                        <Send className="w-4 h-4" />
                        {evaluating ? "Evaluating…" : "Submit Answer"}
                      </Button>
                    )}
                  </div>
                </div>
              </div>

              {/* Col 3: AI Coach */}
              <div className="lg:col-span-3">
                <div className="bento-card h-full flex flex-col">
                  <div className="flex items-center gap-2 mb-3">
                    <div
                      className="w-8 h-8 rounded-lg flex items-center justify-center"
                      style={{ background: "var(--gradient-accent)" }}
                    >
                      <Sparkles className="w-4 h-4 text-primary-foreground" />
                    </div>
                    <div>
                      <h3 className="font-semibold text-sm">AI Coach</h3>
                      <p className="text-[10px] text-muted-foreground">Live feedback</p>
                    </div>
                  </div>

                  {currentEval && (
                    <div className="mb-3 p-3 rounded-lg border border-primary/30 bg-primary/5">
                      <div className="flex items-baseline justify-between mb-1">
                        <span className="text-xs text-muted-foreground">Score</span>
                        <span className="text-3xl font-bold text-gradient tabular-nums">
                          {currentEval.score}
                          <span className="text-sm text-muted-foreground">/10</span>
                        </span>
                      </div>
                      <Progress value={currentEval.score * 10} className="h-1.5" />
                    </div>
                  )}

                  <div className="flex-1 min-h-[200px] max-h-[420px] overflow-y-auto space-y-2 pr-1">
                    {chat.length === 0 && (
                      <p className="text-xs text-muted-foreground italic">
                        Submit your answer to get instant coaching.
                      </p>
                    )}
                    {chat.map((m, i) => (
                      <div
                        key={i}
                        className={`text-xs p-2.5 rounded-lg ${m.role === "coach" ? "bg-secondary/60 border border-border" : "bg-primary/10 border border-primary/20 ml-4"}`}
                      >
                        <div className="font-semibold text-[10px] uppercase tracking-wide mb-1 opacity-70">
                          {m.role === "coach" ? "Coach" : "You"}
                        </div>
                        <div className="leading-relaxed">{m.text}</div>
                      </div>
                    ))}
                    {evaluating && (
                      <div className="text-xs p-2.5 rounded-lg bg-secondary/60 border border-border">
                        <div className="font-semibold text-[10px] uppercase tracking-wide mb-1 opacity-70">
                          Coach
                        </div>
                        <div className="skeleton-shimmer h-3 w-full mb-1" />
                        <div className="skeleton-shimmer h-3 w-3/4" />
                      </div>
                    )}
                  </div>

                  {currentEval && (
                    <details className="mt-3 text-xs">
                      <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                        💡 Ideal answer
                      </summary>
                      <p className="mt-2 p-2 rounded bg-accent/10 border border-accent/20 leading-relaxed">
                        {currentEval.ideal_answer}
                      </p>
                    </details>
                  )}
                </div>
              </div>
            </div>
          </>
        )}

        {phase === "REPORT" && (
          <ReportView questions={questions} evaluations={evaluations} onRestart={resetAll} />
        )}
      </main>
    </div>
  );
}

function SetupView(props: {
  type: string;
  setType: (v: string) => void;
  difficulty: string;
  setDifficulty: (v: string) => void;
  name: string;
  setName: (v: string) => void;
  email: string;
  setEmail: (v: string) => void;
  phone: string;
  setPhone: (v: string) => void;
  resumeName: string;
  resumeUploadedText: string;
  pastedText: string;
  setPastedText: (v: string) => void;
  onResume: (f: File) => void;
  onStart: () => void;
  disabled: boolean;
}) {
  const [showTextarea, setShowTextarea] = useState(false);

  useEffect(() => {
    if (props.resumeUploadedText || props.pastedText) {
      setShowTextarea(true);
    }
  }, [props.resumeUploadedText, props.pastedText]);

  return (
    <div className="max-w-3xl mx-auto pt-6">
      <div className="text-center mb-10">
        <Badge variant="secondary" className="mb-4">
          Powered by Gemini · Free & Fast
        </Badge>
        <h2 className="text-5xl font-bold mb-4 leading-tight">
          Practice interviews with a <span className="text-gradient">live AI coach</span>.
        </h2>
        <p className="text-lg text-muted-foreground max-w-xl mx-auto">
          Fill in your details below, upload your resume, and get 5 tailored questions.
        </p>
      </div>

      <Card className="bento-card grid grid-cols-1 md:grid-cols-2 gap-5 !p-6">
        <div className="space-y-2">
          <label className="text-sm font-medium">Interview type</label>
          <Select value={props.type} onValueChange={props.setType}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="Technical">Technical</SelectItem>
              <SelectItem value="Behavioral">Behavioral</SelectItem>
              <SelectItem value="System Design">System Design</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">Difficulty</label>
          <Select value={props.difficulty} onValueChange={props.setDifficulty}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="Junior">Junior</SelectItem>
              <SelectItem value="Mid">Mid</SelectItem>
              <SelectItem value="Senior">Senior</SelectItem>
              <SelectItem value="Staff">Staff+</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="md:col-span-2 space-y-2">
          <label className="text-sm font-medium">Full Name</label>
          <Input
            type="text"
            placeholder="John Doe"
            value={props.name}
            onChange={(e) => props.setName(e.target.value)}
          />
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">Email Address</label>
          <Input
            type="email"
            placeholder="john@example.com"
            value={props.email}
            onChange={(e) => props.setEmail(e.target.value)}
          />
        </div>

        <div className="space-y-2">
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium">Phone Number (WhatsApp)</label>
            <span className="text-[10px] text-muted-foreground">
              Provide WhatsApp to get your results directly on your phone
            </span>
          </div>
          <div className="flex gap-2">
            <span className="flex items-center justify-center bg-muted text-muted-foreground px-3 rounded-md border border-input text-sm font-semibold select-none">
              +91
            </span>
            <Input
              type="tel"
              placeholder="9876543210"
              value={props.phone}
              onChange={(e) => props.setPhone(e.target.value.replace(/\D/g, "").slice(0, 10))}
              className="flex-1"
            />
          </div>
        </div>

        <div className="md:col-span-2 space-y-2">
          <label className="text-sm font-medium">Resume / Job Description</label>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="md:col-span-1">
              <label className="flex flex-col items-center justify-center h-full min-h-[120px] p-4 rounded-lg border-2 border-dashed border-border hover:border-primary/50 cursor-pointer transition-colors text-center bg-muted/5">
                <Upload className="w-5 h-5 text-muted-foreground mb-2" />
                <span className="text-xs text-muted-foreground font-medium">
                  {props.resumeName || "Upload PDF or TXT"}
                </span>
                <input
                  type="file"
                  accept=".txt,.md,.pdf"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) props.onResume(f);
                  }}
                />
              </label>
            </div>
            <div className="md:col-span-2">
              {showTextarea ? (
                <div className="relative h-full min-h-[120px]">
                  <Textarea
                    value={props.pastedText}
                    onChange={(e) => props.setPastedText(e.target.value)}
                    placeholder={
                      props.resumeUploadedText
                        ? "Resume successfully uploaded! You can now paste the Job Description (JD) here to align questions..."
                        : "Paste your resume or job description text directly here to customize the interview questions..."
                    }
                    className="h-full min-h-[120px] resize-none font-sans text-xs bg-input"
                  />
                  {props.pastedText && (
                    <button
                      type="button"
                      onClick={() => {
                        props.setPastedText("");
                        setShowTextarea(false);
                      }}
                      className="absolute top-2 right-2 text-[10px] bg-destructive/25 hover:bg-destructive/40 text-destructive-foreground px-1.5 py-0.5 rounded border border-destructive/20"
                    >
                      Clear
                    </button>
                  )}
                </div>
              ) : (
                <div
                  onClick={() => setShowTextarea(true)}
                  className="flex flex-col items-center justify-center h-full min-h-[120px] p-4 rounded-lg border-2 border-dashed border-border hover:border-primary/50 cursor-pointer transition-colors text-center bg-muted/5"
                >
                  <span className="text-xs text-muted-foreground font-medium">
                    {props.resumeUploadedText
                      ? "OR Paste Job Description (JD) Here directly"
                      : "OR Paste your resume / Job Description Here Directly"}
                  </span>
                  <span className="text-[10px] text-muted-foreground/60 mt-1">
                    (Click to expand text box)
                  </span>
                </div>
              )}
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground">
            {props.resumeUploadedText
              ? "Resume uploaded successfully. Paste target JD to customize questions."
              : "Uploading a file extracts its text (Resume). You can then paste the Job Description (JD) in the text box."}
          </p>
        </div>

        <div className="md:col-span-2 flex justify-end pt-2">
          <Button
            onClick={props.onStart}
            disabled={props.disabled}
            className="btn-hero gap-2 text-base"
          >
            <Sparkles className="w-4 h-4" />
            Start Interview
          </Button>
        </div>
      </Card>
    </div>
  );
}

function FetchingView() {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 pt-4">
      <div className="lg:col-span-4 space-y-5">
        <div className="bento-card">
          <div className="skeleton-shimmer h-16 w-full" />
        </div>
        <div className="bento-card">
          <div className="skeleton-shimmer h-40 w-full" />
        </div>
      </div>
      <div className="lg:col-span-5">
        <div className="bento-card">
          <div className="skeleton-shimmer h-96 w-full" />
        </div>
      </div>
      <div className="lg:col-span-3">
        <div className="bento-card">
          <div className="skeleton-shimmer h-96 w-full" />
        </div>
      </div>
    </div>
  );
}

function ReportView({
  questions,
  evaluations,
  onRestart,
}: {
  questions: string[];
  evaluations: (Evaluation | null)[];
  onRestart: () => void;
}) {
  const scored = evaluations.filter((e): e is Evaluation => !!e);
  const avg = scored.length
    ? Math.round((scored.reduce((s, e) => s + e.score, 0) / scored.length) * 10) / 10
    : 0;
  return (
    <div className="max-w-4xl mx-auto pt-4">
      <div className="bento-card mb-6 text-center">
        <div
          className="inline-flex items-center justify-center w-16 h-16 rounded-2xl mb-4"
          style={{ background: "var(--gradient-primary)" }}
        >
          <Trophy className="w-8 h-8 text-primary-foreground" />
        </div>
        <h2 className="text-3xl font-bold mb-2">Interview Complete</h2>
        <p className="text-muted-foreground mb-4">Overall performance</p>
        <div className="text-7xl font-bold text-gradient tabular-nums">
          {avg}
          <span className="text-3xl text-muted-foreground">/10</span>
        </div>
        <Button onClick={onRestart} className="btn-hero mt-6 gap-2">
          <RotateCcw className="w-4 h-4" />
          Start New Session
        </Button>
      </div>

      <div className="space-y-4">
        {questions.map((q, i) => {
          const e = evaluations[i];
          return (
            <div key={i} className="bento-card">
              <div className="flex items-start justify-between gap-4 mb-3">
                <div>
                  <div className="text-xs text-muted-foreground mb-1">Question {i + 1}</div>
                  <p className="font-medium">{q}</p>
                </div>
                {e && (
                  <div className="text-right shrink-0">
                    <div className="text-3xl font-bold text-gradient tabular-nums">{e.score}</div>
                    <div className="text-[10px] text-muted-foreground">/ 10</div>
                  </div>
                )}
              </div>
              {e ? (
                <>
                  <p className="text-sm text-muted-foreground mb-3">{e.feedback}</p>
                  <details className="text-sm">
                    <summary className="cursor-pointer text-primary hover:underline">
                      See ideal answer
                    </summary>
                    <p className="mt-2 p-3 rounded-lg bg-accent/10 border border-accent/20 leading-relaxed">
                      {e.ideal_answer}
                    </p>
                  </details>
                </>
              ) : (
                <p className="text-sm text-muted-foreground italic">Skipped</p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

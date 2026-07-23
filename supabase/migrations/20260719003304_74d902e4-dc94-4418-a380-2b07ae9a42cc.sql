
CREATE TABLE public.interviews (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  session_id TEXT NOT NULL,
  type TEXT NOT NULL,
  difficulty TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'in_progress',
  questions JSONB NOT NULL DEFAULT '[]'::jsonb,
  resume_context TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.responses (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  interview_id UUID NOT NULL REFERENCES public.interviews(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  user_answer TEXT NOT NULL,
  score INT,
  feedback TEXT,
  ideal_answer TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.interviews TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.responses TO anon, authenticated;
GRANT ALL ON public.interviews TO service_role;
GRANT ALL ON public.responses TO service_role;

ALTER TABLE public.interviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.responses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can manage interviews by session" ON public.interviews FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Anyone can manage responses" ON public.responses FOR ALL USING (true) WITH CHECK (true);

CREATE INDEX idx_interviews_session ON public.interviews(session_id);
CREATE INDEX idx_responses_interview ON public.responses(interview_id);

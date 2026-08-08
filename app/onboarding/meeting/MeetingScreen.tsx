"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { GenesisAvatar } from "@/app/dashboard/GenesisAvatar";
import { GENESIS_AVATAR_SIZE } from "@/lib/dashboard/genesisAvatarSize";
import { GENESIS_ATMOSPHERE } from "@/lib/dashboard/genesisAtmosphere";
import { setGenesisComposing } from "@/lib/dashboard/genesisActivity";
import { callGenesisAction } from "@/lib/dashboard/submitGenesisAction";
import { ActionDiffRows } from "@/lib/execution/ActionDiff";
import { submitMeetingTurn, approveMeetingRecommendation, declineMeetingRecommendation } from "./actions";
import type { FollowUpTurn } from "./ask";
import type { MeetingRecommendation } from "./recommend";

// The First Meeting with J4 — MEETING_WITH_J4.md, frozen v1, now complete
// end to end (M3-M7). Same visual treatment as LaunchScreen.tsx (the
// Partnership ceremony this meeting directly continues): idle avatar
// throughout, real async work, no fabricated progress. Reflect -> Listen
// -> Ask (looped for as many real turns as decideNextMeetingStep actually
// warrants) -> Recommend, exactly one thing -> Explain/Approve/Execute,
// immediately, in the same conversation.
type Beat =
  | "reflect"
  | "converse"
  | "converse_submitting"
  | "recommend"
  | "recommend_submitting"
  | "result";

const OPENING_QUESTION = "What do you want this to become?";

const shell =
  "fixed inset-0 z-[100] flex flex-col items-center justify-center gap-6 px-8 text-center overflow-y-auto py-12";

const primaryButton =
  "rounded-full px-7 py-3 text-sm font-semibold transition-transform hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50 disabled:hover:scale-100";

const ghostButton = "rounded-full border px-6 py-2.5 text-sm transition-colors";

export function MeetingScreen({ reflection }: { reflection: string }) {
  const router = useRouter();
  const [beat, setBeat] = useState<Beat>("reflect");
  const [transcript, setTranscript] = useState<FollowUpTurn[]>([]);
  const [question, setQuestion] = useState(OPENING_QUESTION);
  const [answer, setAnswer] = useState("");
  const [recommendation, setRecommendation] = useState<MeetingRecommendation | null>(null);
  const [resultMessage, setResultMessage] = useState<string | null>(null);
  // Reliability hardening — a real network/timeout failure never produces a
  // new question/recommendation (the server-side work never completed or
  // its response never arrived), so this reverts to the prior retryable
  // beat rather than advancing — nothing the owner already said is lost
  // (transcript/answer/recommendation state is untouched on failure).
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const submitTurn = () => {
    setErrorMessage(null);
    setBeat("converse_submitting");
    startTransition(async () => {
      const outcome = await callGenesisAction(() => submitMeetingTurn(transcript, question, answer));
      if (!outcome.ok) {
        setErrorMessage(outcome.message);
        setBeat("converse");
        return;
      }
      const result = outcome.value;
      if (result.action === "ask") {
        setTranscript((prev) => [...prev, { question, answer: answer.trim() }]);
        setQuestion(result.question);
        setAnswer("");
        setBeat("converse");
        return;
      }
      if (result.action === "recommend") {
        setRecommendation(result.recommendation);
        setBeat("recommend");
        return;
      }
      router.push("/dashboard");
    });
  };

  const decide = (approve: boolean) => {
    if (!recommendation) return;
    setErrorMessage(null);
    setBeat("recommend_submitting");
    startTransition(async () => {
      const outcome = await callGenesisAction(() =>
        approve
          ? approveMeetingRecommendation(recommendation.approvalRequestId)
          : declineMeetingRecommendation(recommendation.approvalRequestId)
      );
      if (!outcome.ok) {
        setErrorMessage(outcome.message);
        setBeat("recommend");
        return;
      }
      setResultMessage(outcome.value.message);
      setBeat("result");
    });
  };

  return (
    <div className={shell} style={{ backgroundColor: GENESIS_ATMOSPHERE.bg }}>
      <GenesisAvatar className={GENESIS_AVATAR_SIZE.lg} />

      {errorMessage && (beat === "converse" || beat === "recommend") && (
        <p className="max-w-md text-sm text-red-500" role="alert">
          {errorMessage}
        </p>
      )}

      {beat === "reflect" && (
        <>
          <p className="max-w-md text-lg font-medium" style={{ color: GENESIS_ATMOSPHERE.text }}>
            {reflection}
          </p>
          <button
            onClick={() => setBeat("converse")}
            className={primaryButton}
            style={{ backgroundColor: GENESIS_ATMOSPHERE.violet, color: GENESIS_ATMOSPHERE.bgElevated }}
          >
            Continue
          </button>
        </>
      )}

      {(beat === "converse" || beat === "converse_submitting") && (
        <>
          <p className="max-w-md text-lg font-medium" style={{ color: GENESIS_ATMOSPHERE.text }}>
            {question}
          </p>
          {question === OPENING_QUESTION && (
            <p className="max-w-sm text-sm" style={{ color: GENESIS_ATMOSPHERE.textSecondary }}>
              Tell me the vision — as much or as little as you want.
            </p>
          )}
          <textarea
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            onFocus={() => setGenesisComposing(true)}
            onBlur={() => setGenesisComposing(false)}
            disabled={beat === "converse_submitting"}
            rows={4}
            placeholder="Where do you see this a year from now…"
            className="w-full max-w-md rounded-2xl border px-5 py-4 text-sm"
            style={{
              backgroundColor: "rgba(244,242,251,0.04)",
              borderColor: GENESIS_ATMOSPHERE.border,
              color: GENESIS_ATMOSPHERE.text,
            }}
          />
          <button
            onClick={submitTurn}
            disabled={beat === "converse_submitting"}
            className={primaryButton}
            style={{ backgroundColor: GENESIS_ATMOSPHERE.violet, color: GENESIS_ATMOSPHERE.bgElevated }}
          >
            {beat === "converse_submitting" ? "One moment..." : "Continue"}
          </button>
        </>
      )}

      {(beat === "recommend" || beat === "recommend_submitting") && recommendation && (
        <>
          <p className="max-w-md text-lg font-medium" style={{ color: GENESIS_ATMOSPHERE.text }}>
            {recommendation.summary}
          </p>
          <div
            className="w-full max-w-md rounded-2xl border p-4 text-left"
            style={{ borderColor: GENESIS_ATMOSPHERE.border, backgroundColor: "rgba(244,242,251,0.04)" }}
          >
            <ActionDiffRows input={recommendation.input} previousValues={recommendation.previousValues} />
          </div>
          <div className="flex gap-3">
            <button
              onClick={() => decide(true)}
              disabled={beat === "recommend_submitting"}
              className={primaryButton}
              style={{ backgroundColor: GENESIS_ATMOSPHERE.violet, color: GENESIS_ATMOSPHERE.bgElevated }}
            >
              {beat === "recommend_submitting" ? "One moment..." : "Yes, let's do it"}
            </button>
            <button
              onClick={() => decide(false)}
              disabled={beat === "recommend_submitting"}
              className={ghostButton}
              style={{ borderColor: GENESIS_ATMOSPHERE.border, color: GENESIS_ATMOSPHERE.textSecondary }}
            >
              Not right now
            </button>
          </div>
        </>
      )}

      {beat === "result" && resultMessage && (
        <>
          <p className="max-w-md text-lg font-medium" style={{ color: GENESIS_ATMOSPHERE.text }}>
            {resultMessage}
          </p>
          <button
            onClick={() => router.push("/dashboard")}
            className={primaryButton}
            style={{ backgroundColor: GENESIS_ATMOSPHERE.violet, color: GENESIS_ATMOSPHERE.bgElevated }}
          >
            Go to dashboard
          </button>
        </>
      )}
    </div>
  );
}

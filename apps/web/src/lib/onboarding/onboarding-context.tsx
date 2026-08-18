"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { getActiveWorkspacePath } from "@/lib/workspaces/actions";
import { saveOnboardingProgress, saveOnboardingSurvey } from "./actions";
import {
  deriveFlowType,
  type FlowType,
  type OnboardingProgress,
  type SetupStage,
} from "./steps";

interface ResponsesSnapshot {
  flowType: FlowType | null;
  agent: string | null;
  agentOther: string;
  discovery: string[];
  interests: string[];
}

/** Full survey payload — the upsert overwrites `responses` wholesale, so
 * every save must carry the complete snapshot. */
const buildResponses = (snapshot: ResponsesSnapshot) => ({
  flowType: snapshot.flowType,
  agent: snapshot.agent,
  discovery: snapshot.discovery,
  interests: snapshot.interests,
  ...(snapshot.agent === "other" && snapshot.agentOther.trim()
    ? { agentName: snapshot.agentOther.trim() }
    : {}),
});

interface OnboardingContextValue {
  discovery: string[];
  interests: string[];
  flowType: FlowType | null;
  agent: string | null;
  agentOther: string;
  setAgentOther: (value: string) => void;
  setupStage: SetupStage;
  setSetupStage: (stage: SetupStage) => void;
  testRunReady: boolean;
  setTestRunReady: (ready: boolean) => void;
  completing: boolean;
  /** Live view of the flow state in `OnboardingProgress` shape, for the
   * index resume redirect and step guards. */
  progress: OnboardingProgress;
  applyWelcome: (data: { discovery: string[]; interests: string[] }) => void;
  selectAgent: (agentId: string) => void;
  confirmOtherAgent: () => boolean;
  resetAgent: () => void;
  handleComplete: () => Promise<void>;
}

const OnboardingContext = createContext<OnboardingContextValue | null>(null);

export const OnboardingProvider = ({
  initial,
  children,
}: {
  initial: OnboardingProgress;
  children: React.ReactNode;
}) => {
  const router = useRouter();
  const [discovery, setDiscovery] = useState(initial.discovery);
  const [interests, setInterests] = useState(initial.interests);
  const [flowType, setFlowType] = useState(initial.flowType);
  const [agent, setAgent] = useState(initial.agent);
  const [agentOther, setAgentOther] = useState(
    initial.agent === "other" ? (initial.agentName ?? "") : "",
  );
  const [setupStage, setSetupStage] = useState(initial.setupStage);
  const [testRunReady, setTestRunReady] = useState(false);
  const [completing, setCompleting] = useState(false);

  const progress = useMemo<OnboardingProgress>(
    () => ({
      discovery,
      interests,
      flowType,
      agent,
      agentName: agentOther.trim() ? agentOther : null,
      setupStage,
    }),
    [discovery, interests, flowType, agent, agentOther, setupStage],
  );

  const applyWelcome = (data: { discovery: string[]; interests: string[] }) => {
    const derived = deriveFlowType(data.interests);
    // A flow switch invalidates the previously picked agent (the agent lists
    // differ per flow); otherwise the selection survives back-navigation.
    const flowChanged = flowType !== null && derived !== flowType;
    const nextAgent = flowChanged ? null : agent;
    const nextAgentOther = flowChanged ? "" : agentOther;

    setDiscovery(data.discovery);
    setInterests(data.interests);
    setFlowType(derived);
    if (flowChanged) {
      setAgent(null);
      setAgentOther("");
    }

    void saveOnboardingProgress(
      buildResponses({
        flowType: derived,
        agent: nextAgent,
        agentOther: nextAgentOther,
        discovery: data.discovery,
        interests: data.interests,
      }),
    );
  };

  const selectAgent = (agentId: string) => {
    setAgent(agentId);
    // "other" persists on confirm, once the custom name is typed.
    if (agentId !== "other") {
      void saveOnboardingProgress(
        buildResponses({
          flowType,
          agent: agentId,
          agentOther,
          discovery,
          interests,
        }),
      );
    }
  };

  const confirmOtherAgent = (): boolean => {
    if (!agentOther.trim()) return false;
    void saveOnboardingProgress(
      buildResponses({
        flowType,
        agent: "other",
        agentOther,
        discovery,
        interests,
      }),
    );
    return true;
  };

  const resetAgent = () => {
    setAgent(null);
    setAgentOther("");
  };

  // Persist the survey once when the first gateway request is detected —
  // ref-gated so later answer edits don't re-trigger a full (completing) save.
  const testRunSavedRef = useRef(false);
  useEffect(() => {
    if (testRunReady && !testRunSavedRef.current) {
      testRunSavedRef.current = true;
      void saveOnboardingSurvey(
        buildResponses({ flowType, agent, agentOther, discovery, interests }),
      );
    }
  }, [testRunReady, flowType, agent, agentOther, discovery, interests]);

  // Persist the survey responses as soon as the agent install is detected, so
  // the discovery/interests/agent answers aren't lost if the user runs the
  // script and leaves without clicking "Go to Dashboard". (Running the script
  // also marks onboarding complete server-side, on fetch.) Deliberately not
  // seeded from the resumed stage: one save per session is idempotent for
  // completed users and heals a default-agent rename a previous visit missed.
  const surveySavedRef = useRef(false);
  useEffect(() => {
    if (
      (setupStage === "installed" || setupStage === "connected") &&
      !surveySavedRef.current
    ) {
      surveySavedRef.current = true;
      void saveOnboardingSurvey(
        buildResponses({ flowType, agent, agentOther, discovery, interests }),
      );
    }
  }, [setupStage, flowType, agent, agentOther, discovery, interests]);

  const handleComplete = async () => {
    setCompleting(true);
    try {
      // Independent calls: the workspace path never depends on the survey write.
      const [result, path] = await Promise.all([
        saveOnboardingSurvey(
          buildResponses({ flowType, agent, agentOther, discovery, interests }),
        ),
        getActiveWorkspacePath(),
      ]);
      if (!result.ok) {
        toast.error(result.error);
        setCompleting(false);
        return;
      }
      router.replace(path);
    } catch {
      toast.error("Something went wrong.");
      setCompleting(false);
    }
  };

  return (
    <OnboardingContext.Provider
      value={{
        discovery,
        interests,
        flowType,
        agent,
        agentOther,
        setAgentOther,
        setupStage,
        setSetupStage,
        testRunReady,
        setTestRunReady,
        completing,
        progress,
        applyWelcome,
        selectAgent,
        confirmOtherAgent,
        resetAgent,
        handleComplete,
      }}
    >
      {children}
    </OnboardingContext.Provider>
  );
};

export const useOnboarding = (): OnboardingContextValue => {
  const context = useContext(OnboardingContext);
  if (!context) {
    throw new Error("useOnboarding must be used within OnboardingProvider");
  }
  return context;
};

export interface AgentAskUserQuestionOptionVM {
  label: string;
  description: string;
}

export interface AgentAskUserQuestionVM {
  id: string;
  header: string;
  question: string;
  options: AgentAskUserQuestionOptionVM[];
  multiSelect: boolean;
  allowFreeText?: boolean;
  answer?: string | string[] | null;
}

export interface AgentAskUserQuestionItemVM {
  kind: "ask-user";
  id: string;
  turnId: string;
  requestId: string;
  title: string;
  status: string | null;
  questions: AgentAskUserQuestionVM[];
  occurredAtUnixMs: number | null;
}

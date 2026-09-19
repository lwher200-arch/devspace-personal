export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type StructuredValue = string | JsonValue[] | { [key: string]: JsonValue };
export type EntryType = StructuredValue | null;

export interface NoulQuestion {
  type: "noul";
  instructions: StructuredValue;
  criteria?: { true?: EntryType; false?: EntryType } | null;
}

export interface ChoiceQuestion {
  type: "choice";
  instructions: StructuredValue;
  criteria: Record<string, EntryType>;
}

export interface ScoreQuestion {
  type: "score";
  instructions: StructuredValue;
  criteria: [EntryType, EntryType, ...EntryType[]];
}

export type DecisionQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export interface DecisionRequest {
  state: StructuredValue;
  questions: Record<string, DecisionQuestion>;
  model?: string;
}

export interface NoulAnswer {
  type: "noul";
  noul: number;
}

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface ScoreAnswer {
  type: "score";
  score: number;
  legend: Record<string, EntryType>;
  probabilities: Record<string, number>;
  confidence: number;
}

export type DecisionAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface DecisionUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface DecisionResult {
  provider: string;
  model: string;
  answers: Record<string, DecisionAnswer>;
  usage: DecisionUsage;
  redactedPaths?: string[];
}

export interface DecisionIntelligenceProvider {
  readonly id: string;
  evaluate(request: DecisionRequest): Promise<DecisionResult>;
}

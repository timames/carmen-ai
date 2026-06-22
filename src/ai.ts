const MODELS = {
  general: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  coder: "@cf/qwen/qwen2.5-coder-32b-instruct",
  reasoning: "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
} as const;

type TaskType = "coding" | "reasoning" | "general";

function detectTaskType(
  messages: Array<{ role: string; content: string }>
): TaskType {
  const last = messages[messages.length - 1];
  if (!last) return "general";

  const content =
    typeof last.content === "string" ? last.content.toLowerCase() : "";

  const codingPatterns = [
    /\b(write|create|build|implement|code|function|class|method|api|endpoint)\b.*\b(python|javascript|typescript|c#|\.net|react|sql|bash|html|css)\b/,
    /\b(debug|fix|refactor|optimize|review)\b.*\b(code|function|bug|error|exception)\b/,
    /```\w*\n/,
    /\b(import |from |require\(|const |let |var |def |class |async |await )\b/,
    /\b(pull request|commit|git|npm|pip|docker|deploy)\b/,
  ];
  for (const p of codingPatterns) {
    if (p.test(content)) return "coding";
  }

  const reasoningPatterns = [
    /\b(analyze|compare|evaluate|reason|prove|derive|calculate)\b.*\b(why|how|impact|effect|difference|trade.?off)\b/,
    /\b(step.by.step|think through|break down|pros and cons)\b/,
    /\b(mathematical|equation|formula|theorem|proof|logic)\b/,
    /\b(strategy|plan|architecture|design decision|trade.?off)\b/,
  ];
  for (const p of reasoningPatterns) {
    if (p.test(content)) return "reasoning";
  }

  return "general";
}

export function resolveModel(
  modelChoice: string,
  messages: Array<{ role: string; content: string }>
): { model: string; taskType: string } {
  if (modelChoice === "auto") {
    const taskType = detectTaskType(messages);
    const model = taskType === "coding" ? MODELS.coder : taskType === "reasoning" ? MODELS.reasoning : MODELS.general;
    return { model, taskType };
  }

  if (modelChoice in MODELS) {
    return {
      model: MODELS[modelChoice as keyof typeof MODELS],
      taskType: modelChoice,
    };
  }

  return { model: modelChoice, taskType: "manual" };
}

export function getAvailableModels() {
  return [
    {
      id: "auto",
      name: "Auto (Smart Router)",
      description: "Automatically selects the best model for your task",
    },
    {
      id: "general",
      name: "Llama 3.3 70B",
      description: "General chat, documents, and instruction following",
      model: MODELS.general,
    },
    {
      id: "coder",
      name: "Qwen 2.5 Coder 32B",
      description: "Code generation and review",
      model: MODELS.coder,
    },
    {
      id: "reasoning",
      name: "DeepSeek R1 32B",
      description: "Complex reasoning, math, and analysis",
      model: MODELS.reasoning,
    },
  ];
}

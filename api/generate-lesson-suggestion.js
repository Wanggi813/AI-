// Vercel Serverless Function (Node.js runtime).
// GROQ_API_KEY는 Vercel 프로젝트 설정 > Environment Variables에만 등록하세요.

const GROQ_MODEL = "llama-3.3-70b-versatile";

const SYSTEM_PROMPT = "당신은 한국 중학교 과학 교사입니다. 모든 응답 내용은 100% 순수한 한글 문장으로만 작성합니다. " +
  "영어 단어, 로마자 표기, 학자 이름이나 연도 같은 인용, 영문 약어를 절대 사용하지 않습니다. " +
  "JSON의 키 이름만 영어를 그대로 쓰고, 값(내용)은 전부 한글로 씁니다.";

function buildPrompt({ className, studentCount, avgCorrect, totalQuestions, misconceptions }) {
  const list = misconceptions
    .map((m, i) => `${i + 1}. ${m.label} — ${m.count}명 (${m.percent}%)`)
    .join("\n");

  return `다음은 "${className}" 학급의 에너지 오개념 진단 결과입니다.

- 참여 학생 수: ${studentCount}명
- 평균 정답 수: ${avgCorrect} / ${totalQuestions}
- 오개념 발생 빈도 (많이 나타난 순):
${list}

이 데이터를 바탕으로 다음 수업에서 무엇을 강조하면 좋을지 제안해 주세요. 조건:
- summary: 이 학급의 전반적인 이해 수준과 특징을 2~3문장으로 요약하세요.
- priorities: 빈도가 높은 오개념 중 우선적으로 다뤄야 할 2~4개를 골라, 각각에 대해 왜 중요한지와 수업에서 구체적으로 어떻게 다룰지(예시, 비유, 질문 등)를 2문장 정도로 제안하세요.
- activities: 이 학급에 맞는 구체적인 수업 활동이나 실험을 2~4개 제안하세요 (예: 특정 실험, 토론 주제, 형성평가 문항 유형 등).
- 모든 문장은 실제 중학교 교사가 바로 활용할 수 있도록 구체적이고 실용적인 한국어로, 영어 단어 없이 작성하세요.

다음 JSON 형식으로만 답하세요. 다른 설명이나 마크다운 없이 순수 JSON만 출력하세요:
{
  "summary": "string",
  "priorities": [ { "label": "string", "suggestion": "string" } ],
  "activities": ["string"]
}`;
}

function isValidSuggestion(data) {
  return data
    && typeof data.summary === "string"
    && Array.isArray(data.priorities)
    && data.priorities.every(p => p && typeof p.label === "string" && typeof p.suggestion === "string")
    && Array.isArray(data.activities)
    && data.activities.every(a => typeof a === "string");
}

// 3자 이상 이어지는 로마자 문자열을 "영어가 섞였다"는 신호로 간주 (단위 표기 kg, cm 등은 2자라 걸리지 않음)
function hasForeignText(value) {
  if (typeof value === "string") return /[A-Za-z]{3,}/.test(value);
  if (Array.isArray(value)) return value.some(hasForeignText);
  if (value && typeof value === "object") return Object.values(value).some(hasForeignText);
  return false;
}

async function callGroq(apiKey, messages) {
  const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages,
      response_format: { type: "json_object" },
      temperature: 0.6
    })
  });

  if (!groqRes.ok) {
    const detail = await groqRes.text();
    throw Object.assign(new Error("Groq API error"), { status: 502, detail });
  }

  const data = await groqRes.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) {
    throw Object.assign(new Error("Groq API returned no content"), { status: 502, detail: JSON.stringify(data) });
  }
  return { parsed: JSON.parse(text), raw: text };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const { className, studentCount, avgCorrect, totalQuestions, misconceptions } = req.body || {};

  if (!className || !Array.isArray(misconceptions) || misconceptions.length === 0) {
    res.status(400).json({ error: "className and misconceptions are required" });
    return;
  }

  const apiKey = (process.env.GROQ_API_KEY || "").trim().replace(/^["']|["']$/g, "");
  if (!apiKey) {
    res.status(500).json({ error: "GROQ_API_KEY is not configured on the server" });
    return;
  }
  if (!apiKey.startsWith("gsk_")) {
    res.status(500).json({
      error: "GROQ_API_KEY looks malformed",
      detail: `key starts with "${apiKey.slice(0, 4)}", expected "gsk_"`
    });
    return;
  }

  const baseMessages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: buildPrompt({ className, studentCount, avgCorrect, totalQuestions, misconceptions }) }
  ];

  try {
    let { parsed, raw } = await callGroq(apiKey, baseMessages);
    let invalid = !isValidSuggestion(parsed);
    let foreign = !invalid && hasForeignText(parsed);

    if (invalid || foreign) {
      console.error("Retrying generate-lesson-suggestion due to", invalid ? "invalid schema" : "foreign text", raw);
      const retryMessages = [
        ...baseMessages,
        { role: "assistant", content: raw },
        { role: "user", content: "이전 응답에 영어 단어가 섞였거나 형식이 잘못되었습니다. 같은 JSON 형식을 지키되, 모든 내용을 영어 없이 순수한 한글로만 다시 작성해서 보내주세요." }
      ];
      ({ parsed, raw } = await callGroq(apiKey, retryMessages));
      invalid = !isValidSuggestion(parsed);
    }

    if (invalid) {
      console.error("Groq API returned malformed suggestion after retry", raw);
      res.status(502).json({ error: "malformed suggestion from model", detail: raw });
      return;
    }

    res.status(200).json(parsed);
  } catch (error) {
    console.error("generate-lesson-suggestion failed", error);
    res.status(error.status || 500).json({
      error: error.message || "Failed to generate lesson suggestion",
      detail: error.detail || error.message
    });
  }
}

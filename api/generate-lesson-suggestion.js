// Vercel Serverless Function (Node.js runtime).
// GROQ_API_KEY는 Vercel 프로젝트 설정 > Environment Variables에만 등록하세요.

const GROQ_MODEL = "llama-3.3-70b-versatile";

function buildPrompt({ className, studentCount, avgCorrect, totalQuestions, misconceptions }) {
  const list = misconceptions
    .map((m, i) => `${i + 1}. ${m.label} — ${m.count}명 (${m.percent}%)`)
    .join("\n");

  return `당신은 중학교 과학(에너지 단원) 수업을 설계하는 경력 많은 교사입니다.
다음은 "${className}" 학급의 에너지 오개념 진단 결과입니다.

- 참여 학생 수: ${studentCount}명
- 평균 정답 수: ${avgCorrect} / ${totalQuestions}
- 오개념 발생 빈도 (많이 나타난 순):
${list}

이 데이터를 바탕으로 다음 수업에서 무엇을 강조하면 좋을지 제안해 주세요. 조건:
- summary: 이 학급의 전반적인 이해 수준과 특징을 2~3문장으로 요약하세요.
- priorities: 빈도가 높은 오개념 중 우선적으로 다뤄야 할 2~4개를 골라, 각각에 대해 왜 중요한지와 수업에서 구체적으로 어떻게 다룰지(예시, 비유, 질문 등)를 2문장 정도로 제안하세요.
- activities: 이 학급에 맞는 구체적인 수업 활동이나 실험을 2~4개 제안하세요 (예: 특정 실험, 토론 주제, 형성평가 문항 유형 등).
- 모든 문장은 실제 중학교 교사가 바로 활용할 수 있도록 구체적이고 실용적인 한국어로 작성하세요.

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

  try {
    const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [
          { role: "user", content: buildPrompt({ className, studentCount, avgCorrect, totalQuestions, misconceptions }) }
        ],
        response_format: { type: "json_object" },
        temperature: 0.6
      })
    });

    if (!groqRes.ok) {
      const detail = await groqRes.text();
      console.error("Groq API error", groqRes.status, detail);
      res.status(502).json({ error: "Groq API error", detail });
      return;
    }

    const data = await groqRes.json();
    const text = data?.choices?.[0]?.message?.content;

    if (!text) {
      console.error("Groq API returned no content", JSON.stringify(data));
      res.status(502).json({ error: "Groq API returned no content", detail: JSON.stringify(data) });
      return;
    }

    const parsed = JSON.parse(text);

    if (!isValidSuggestion(parsed)) {
      console.error("Groq API returned malformed suggestion", text);
      res.status(502).json({ error: "malformed suggestion from model", detail: text });
      return;
    }

    res.status(200).json(parsed);
  } catch (error) {
    console.error("generate-lesson-suggestion failed", error);
    res.status(500).json({ error: "Failed to generate lesson suggestion", detail: error.message });
  }
}

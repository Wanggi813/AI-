// Vercel Serverless Function (Node.js runtime).
// GROQ_API_KEY는 Vercel 프로젝트 설정 > Environment Variables에만 등록하세요 (절대 클라이언트 코드에 넣지 않기).
// 키는 https://console.groq.com/keys 에서 무료로 발급받을 수 있습니다.

const GROQ_MODEL = "llama-3.3-70b-versatile";

const SYSTEM_PROMPT = "당신은 한국 중학교 과학 교사입니다. 모든 응답 내용은 100% 순수한 한글 문장으로만 작성합니다. " +
  "영어 단어, 로마자 표기, 학자 이름이나 연도 같은 인용, 영문 약어를 절대 사용하지 않습니다. " +
  "JSON의 키 이름만 영어를 그대로 쓰고, 값(내용)은 전부 한글로 씁니다.";

function buildPrompt(misconceptions) {
  const list = misconceptions
    .map((m, i) => `${i + 1}. [tag: ${m.tag}] ${m.label}`)
    .join("\n");

  return `다음은 한 학생이 에너지 오개념 진단에서 실제로 보인 오개념 목록입니다:

${list}

각 오개념마다 학생이 스스로 오개념을 교정할 수 있도록 돕는 4지선다형 피드백 문제를 하나씩 만들어 주세요. 조건:
- 문제는 원래 진단 문항과 똑같은 상황을 반복하지 말고, 같은 오개념을 다른 맥락(다른 예시 상황)에서 확인하는 새로운 문제로 만드세요.
- 보기 4개 중 정답은 1개이며, 나머지 3개는 그럴듯한 오답(흔한 오개념을 반영한 오답)으로 구성하세요.
- correctIndex는 정답 보기의 0부터 시작하는 인덱스입니다.
- explanation에는 왜 그것이 정답인지, 그리고 왜 나머지 보기가 오개념인지 1~2문장으로 설명하세요.
- 각 문제의 tag 값은 입력받은 오개념의 tag 값과 정확히 동일해야 합니다.
- question, options, explanation은 반드시 순수한 한글 문장으로만 작성하세요. 영어 단어, 로마자 표기, 학자 이름이나 연도 같은 인용 표시를 절대 포함하지 마세요.

다음 JSON 형식으로만 답하세요. 다른 설명이나 마크다운 없이 순수 JSON만 출력하세요:
{
  "questions": [
    { "tag": "string", "question": "string", "options": ["string", "string", "string", "string"], "correctIndex": 0, "explanation": "string" }
  ]
}`;
}

function isValidQuestion(q) {
  return q
    && typeof q.tag === "string"
    && typeof q.question === "string"
    && Array.isArray(q.options) && q.options.length === 4 && q.options.every(o => typeof o === "string")
    && Number.isInteger(q.correctIndex) && q.correctIndex >= 0 && q.correctIndex <= 3
    && typeof q.explanation === "string";
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

  const { misconceptions } = req.body || {};

  if (!Array.isArray(misconceptions) || misconceptions.length === 0) {
    res.status(400).json({ error: "misconceptions array is required" });
    return;
  }

  const apiKey = (process.env.GROQ_API_KEY || "").trim().replace(/^["']|["']$/g, "");
  if (!apiKey) {
    res.status(500).json({ error: "GROQ_API_KEY is not configured on the server" });
    return;
  }
  if (!apiKey.startsWith("gsk_")) {
    console.error("GROQ_API_KEY does not look like a Groq key (should start with gsk_)");
    res.status(500).json({
      error: "GROQ_API_KEY looks malformed",
      detail: `key starts with "${apiKey.slice(0, 4)}", expected "gsk_"`
    });
    return;
  }

  const baseMessages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: buildPrompt(misconceptions) }
  ];

  try {
    let { parsed, raw } = await callGroq(apiKey, baseMessages);
    let invalid = !Array.isArray(parsed.questions) || !parsed.questions.every(isValidQuestion);
    let foreign = !invalid && hasForeignText(parsed.questions);

    if (invalid || foreign) {
      console.error("Retrying generate-feedback due to", invalid ? "invalid schema" : "foreign text", raw);
      const retryMessages = [
        ...baseMessages,
        { role: "assistant", content: raw },
        { role: "user", content: "이전 응답에 영어 단어가 섞였거나 형식이 잘못되었습니다. 같은 JSON 형식을 지키되, 모든 내용을 영어 없이 순수한 한글로만 다시 작성해서 보내주세요." }
      ];
      ({ parsed, raw } = await callGroq(apiKey, retryMessages));
      invalid = !Array.isArray(parsed.questions) || !parsed.questions.every(isValidQuestion);
    }

    if (invalid) {
      console.error("Groq API returned malformed questions after retry", raw);
      res.status(502).json({ error: "malformed questions from model", detail: raw });
      return;
    }

    res.status(200).json(parsed);
  } catch (error) {
    console.error("generate-feedback failed", error);
    res.status(error.status || 500).json({
      error: error.message || "Failed to generate feedback",
      detail: error.detail || error.message
    });
  }
}

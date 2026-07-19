// Vercel Serverless Function (Node.js runtime).
// GEMINI_API_KEY는 Vercel 프로젝트 설정 > Environment Variables에만 등록하세요 (절대 클라이언트 코드에 넣지 않기).

const GEMINI_MODEL = "gemini-1.5-flash";

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          tag: { type: "string" },
          question: { type: "string" },
          options: {
            type: "array",
            items: { type: "string" }
          },
          correctIndex: { type: "integer" },
          explanation: { type: "string" }
        },
        required: ["tag", "question", "options", "correctIndex", "explanation"]
      }
    }
  },
  required: ["questions"]
};

function buildPrompt(misconceptions) {
  const list = misconceptions
    .map((m, i) => `${i + 1}. [tag: ${m.tag}] ${m.label} (참고: ${m.framework})`)
    .join("\n");

  return `당신은 중학교 과학(에너지 단원) 교사입니다. 다음은 한 학생이 에너지 오개념 진단에서 실제로 보인 오개념 목록입니다:

${list}

각 오개념마다 학생이 스스로 오개념을 교정할 수 있도록 돕는 4지선다형 피드백 문제를 하나씩 만들어 주세요. 조건:
- 문제는 원래 진단 문항과 똑같은 상황을 반복하지 말고, 같은 오개념을 다른 맥락(다른 예시 상황)에서 확인하는 새로운 문제로 만드세요.
- 보기 4개 중 정답은 1개이며, 나머지 3개는 그럴듯한 오답(흔한 오개념을 반영한 오답)으로 구성하세요.
- correctIndex는 정답 보기의 0부터 시작하는 인덱스입니다.
- explanation에는 왜 그것이 정답인지, 그리고 왜 나머지 보기가 오개념인지 1~2문장으로 설명하세요.
- 각 문제의 tag 값은 입력받은 오개념의 tag 값과 정확히 동일해야 합니다.
- 모든 문장은 한국 중학생이 이해하기 쉬운 자연스러운 한국어로 작성하세요.`;
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

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "GEMINI_API_KEY is not configured on the server" });
    return;
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

  try {
    const geminiRes = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: buildPrompt(misconceptions) }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: RESPONSE_SCHEMA
        }
      })
    });

    if (!geminiRes.ok) {
      const detail = await geminiRes.text();
      console.error("Gemini API error", geminiRes.status, detail);
      res.status(502).json({ error: "Gemini API error", detail });
      return;
    }

    const data = await geminiRes.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!text) {
      console.error("Gemini API returned no content", JSON.stringify(data));
      res.status(502).json({ error: "Gemini API returned no content", detail: JSON.stringify(data) });
      return;
    }

    const parsed = JSON.parse(text);
    res.status(200).json(parsed);
  } catch (error) {
    console.error("generate-feedback failed", error);
    res.status(500).json({ error: "Failed to generate feedback", detail: error.message });
  }
}

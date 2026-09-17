import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  try {
    const { maskedText, literacyLevel, userAnswer } = await request.json();
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      return NextResponse.json({ error: "APIキーが設定されていません" }, { status: 500 });
    }

    const hasUserAnswer = !!(userAnswer && userAnswer.trim());

    const prompt = `
あなたはメールセキュリティ教育ツールの分析エンジンです。
以下のメール本文（差出人・件名・日時などのヘッダ情報を含む）を分析し、フィッシング・詐欺・なりすまし等の危険箇所を検出してください。

重要なルール:
1. matched_text は、入力本文に実際に存在する文字列を完全一致で返す。
2. 《PHONE_数字》や《EMAIL_数字》などのトークンは絶対に変更しない。
3. 普通の文章を検出した場合も、入力本文からそのまま抜粋する。
4. 同じ matched_text が本文に複数回ある可能性がある。その場合は context_before と context_after を使って該当箇所を区別する。
5. context_before / context_after は、matched_textの直前・直後に実際に存在する短い文字列を抜粋する。なければ空文字列。
6. URLそのものを検出する場合、入力本文中のURLをそのまま matched_text にする。マスキングされていないURLを勝手に《URL_1》へ変更しない。
7. 出力はJSONのみ。Markdownコードブロックは禁止。
8. categoryは「なりすまし」「緊急性煽り」「個人情報要求」「不審URL」のいずれか。
9. 危険箇所が複数ある場合は、それぞれ別のflagにする。
10. 根拠が弱いものを無理に危険と判定しない。
11. 本文冒頭の「差出人」「件名」「日時」も分析対象に含める。表示名と実際のアドレスの不一致などがあれば、なりすましとして検出してよい。
12. user_answer_feedback は、下部の「ユーザーの回答」を、あなた自身が検出したflagsと照らし合わせて採点する。ユーザーの回答が空、または実質的な内容がない場合は user_answer_feedback を null にする。
13. matched_points / missed_points / incorrect_points の各要素は日本語で1文程度、簡潔にする。存在しなければ空配列。
14. comment は総評を2〜3文。的確だった点は肯定し、見落としがあれば次に活かせるように指摘する。教育的で前向きなトーンにする。

JSON形式:
{
  "risk_score": 0から100の整数,
  "flags": [
    {
      "matched_text": "入力本文中の実在する文字列",
      "context_before": "直前の短い文字列",
      "context_after": "直後の短い文字列",
      "category": "なりすまし または 緊急性煽り または 個人情報要求 または 不審URL",
      "reason_beginner": "初心者にも分かる理由を2文程度",
      "reason_advanced": "技術的な観点からの理由を2文程度",
      "advice": "具体的な対策"
    }
  ],
  "user_answer_feedback": {
    "score_out_of_100": 0から100の整数,
    "matched_points": ["ユーザーが正しく指摘できていた点"],
    "missed_points": ["ユーザーが見落としていた危険箇所"],
    "incorrect_points": ["ユーザーの指摘のうち誤りだった点"],
    "comment": "総評"
  } または null
}

ITリテラシーレベル: ${literacyLevel}

メール本文（ヘッダ含む）:
${maskedText}

ユーザーの回答（このメールで怪しいと思った箇所とその理由。分析結果を見る前に自分で記入したもの）:
${hasUserAnswer ? userAnswer.trim() : "(未回答)"}
`;

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 4096, responseMimeType: "application/json" }
      })
    });

    if (!response.ok) throw new Error("API通信エラー");
    
    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    const cleaned = text.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();

    return NextResponse.json(JSON.parse(cleaned));
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: "分析に失敗しました" }, { status: 500 });
  }
}
const check = (ok, message) => { if (!ok) throw Object.assign(new Error(message), { status: 400 }); };
export const asyncQuestionId = (itemId, index) => JSON.stringify(['request_user_input_async', itemId, index]);
const replyStart = '<send_user_message_question_reply>', replyEnd = '</send_user_message_question_reply>';

export function asyncQuestions(item) {
  if (item.type !== 'agentMessage' || !Array.isArray(item.questions) || !item.questions.length || item.questions.length > 12) return null;
  if (!item.questions.every(q => typeof q.title === 'string' && q.title.length <= 20000 && (q.options == null || Array.isArray(q.options) && q.options.length <= 50 && q.options.every(option => typeof option === 'string' && option.length <= 10000)))) return null;
  return item.questions.map((q, index) => ({ id: asyncQuestionId(item.id, index), header: `问题 ${index + 1}`, question: q.title, isOther: true, isSecret: false, options: q.options?.map(label => ({ label, description: '' })) || null }));
}

export function questionReplies(text) {
  if (typeof text !== 'string' || text.length > 250000) return null;
  text = text.trim(); if (!text.startsWith(replyStart) || !text.endsWith(replyEnd)) return null;
  try {
    const parsed = JSON.parse(text.slice(replyStart.length, -replyEnd.length));
    const replies = Array.isArray(parsed) ? parsed : [parsed];
    if (!replies.length || replies.length > 12 || !replies.every(reply => typeof reply.questionItemId === 'string' && typeof reply.question === 'string' && typeof reply.answer === 'string')) return null;
    return replies;
  } catch { return null; }
}

export function asyncReplyText(params, payload) {
  const mapped = questionResponse(params, payload).answers;
  const answers = params.questions.filter(q => Object.hasOwn(mapped, q.id)).map(q => ({ questionItemId: q.id, question: q.question, answer: mapped[q.id].answers[0] }));
  return answers.length ? `${replyStart}\n${JSON.stringify(answers)}\n${replyEnd}` : null;
}

// Empty answers are the native skip response, never an approval or a new turn.
export function questionResponse(params, { decision, answers, skipped = [] }) {
  check(decision == null || ['accept', 'skip'].includes(decision), '无效的回答操作。');
  if (decision === 'skip') return { answers: {} };
  check(answers && typeof answers === 'object' && !Array.isArray(answers), '请输入回答。');
  const ids = new Set(params.questions.map(q => q.id));
  check(Array.isArray(skipped) && skipped.every(id => ids.has(id)) && new Set(skipped).size === skipped.length, '跳过的问题无效。');
  check(Object.keys(answers).every(id => ids.has(id)), '回答包含未知问题。');
  const result = [];
  for (const q of params.questions) {
    if (skipped.includes(q.id)) { check(!Object.hasOwn(answers, q.id), '同一问题不能同时回答和跳过。'); continue; }
    const answer = Object.hasOwn(answers, q.id) ? answers[q.id] : null;
    check(typeof answer === 'string' && answer.trim() && answer.length <= 10000, '请回答所有问题，或明确选择跳过。');
    if (q.options?.length && q.isOther === false) check(q.options.some(option => option.label === answer), '请选择问题提供的选项。');
    result.push([q.id, { answers: [answer] }]);
  }
  return { answers: Object.fromEntries(result) };
}

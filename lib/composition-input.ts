/**
 * 判断受控输入的 change 是否发生在 IME 组字期间。
 *
 * 中文/日文等 IME 组字时浏览器会持续派发 input 事件，此时
 * `event.nativeEvent.isComposing` 为 true，并由 compositionstart/compositionend
 * 维护的标志补充。组字半成品不应被提交到会触发重算或 React 重挂载的 state，
 * 否则正在编辑的行可能卸载、丢失组字上下文与焦点（已确诊的“鱼ggds”症状）。
 *
 * 该纯函数从 TextInput 抽出，以便在无 DOM 的 node:test 环境下做回归。
 */
export function isComposingChangeEvent(
  composingFlag: boolean,
  nativeIsComposing: boolean | undefined,
): boolean {
  return Boolean(composingFlag) || nativeIsComposing === true;
}

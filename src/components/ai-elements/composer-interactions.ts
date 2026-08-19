export interface ComposerWheelState {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
  deltaY: number;
}

/**
 * Pass the wheel to the conversation only after the composer reaches the
 * boundary in the requested direction. This avoids trapping scroll input in
 * a multiline draft without stealing scroll while the draft can still move.
 */
export function shouldChainComposerWheel({
  scrollTop,
  clientHeight,
  scrollHeight,
  deltaY,
}: ComposerWheelState): boolean {
  if (deltaY === 0) return false;

  const atTop = scrollTop <= 0;
  const atEnd = scrollTop + clientHeight >= scrollHeight - 1;
  return deltaY < 0 ? atTop : atEnd;
}

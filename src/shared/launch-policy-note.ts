/**
 * The honesty line beside a delegation picker, for every such picker there is.
 *
 * Every delegation preference in Toucan is workspace-wide, but the policy a *session* carries is
 * fixed when that session is created or resumed. A picker that showed only the preference would
 * therefore lie about the conversation the user is looking at. The note is the correction: it
 * appears only when the selection and the running session disagree, because when they agree there
 * is nothing to say and the option's own wording already carries that a policy is requested, never
 * enforced.
 *
 * One home rather than one per picker: the routine and decision displays had this reasoning
 * written out twice, word for word, and a third picker would have made it three (#230). What a
 * caller still owns is its own vocabulary - `subject` names what is being delegated - and the
 * mapping from its provider-specific `applied` payload onto `LaunchedDelegation`.
 */

/**
 * What a running session actually launched with, reduced to what the note needs to know.
 *
 * `matchesSelection` is asked of the caller rather than derived here because "the same policy"
 * means different things per picker: an on/off toggle matches whenever it is delegating at all,
 * while a worker-model picker matches only the very model that is now selected.
 */
export type LaunchedDelegation =
  /** The session could not apply the policy; `message` is the reason, when the source gave one. */
  | { status: 'unavailable'; message: string | undefined }
  | { status: 'delegating'; matchesSelection: boolean }
  | { status: 'off' }

/**
 * What to say beside the picker, or undefined when the preference and the session agree.
 *
 * `subject` is the word the "still delegating" wording needs - `'decisions'` reads as "Still
 * delegating decisions until this conversation restarts"; omitting it leaves the bare verb.
 */
export function launchPolicyNote(
  preferenceOn: boolean,
  applied: LaunchedDelegation,
  subject?: string
): string | undefined {
  if (applied.status === 'unavailable') return applied.message
  const delegating = applied.status === 'delegating'
  if (preferenceOn && !(delegating && applied.matchesSelection))
    return 'Applies when this conversation next starts or resumes'
  if (!preferenceOn && delegating)
    return `Still delegating${subject ? ` ${subject}` : ''} until this conversation restarts`
  return undefined
}

import type { AgentModel } from '../../src/shared/agent'
import type { AgentModelCatalogue } from '../../src/shared/agent-model-catalogue'
import type { RemoteChatKind, RemoteWorkspaceSnapshot } from '../../src/shared/remote-access'
import { remoteChatSpawnProblem, type RemoteChatSpawnRequest } from '../../src/shared/remote-spawn'

/**
 * Everything the "New chat" form decides, without a DOM.
 *
 * The form is three choices - which project, which agent, what to say first - and the interesting
 * rules are all about *what a phone is allowed to assume*. The project list is the desktop's
 * published projection, so a project can disappear between opening the form and pressing Start;
 * the initial prompt is optional, so an empty box is not an error but also not a prompt; and the
 * refusal wording comes from the shared `remoteChatSpawnProblem`, so the greyed-out button and the
 * host's own answer never say two different things.
 */
export interface NewChatForm {
  projectId: string
  kind: RemoteChatKind
  /** As typed. Trimmed on the way into a request, and omitted entirely when it is empty. */
  input: string
  /**
   * The model to open on, or `''` for the desktop's own default. Empty is the *normal* value, not
   * an unfilled field: the desktop has a default and the catalogue may be empty, so a form that
   * demanded a model would be unsubmittable exactly where it is least useful.
   */
  modelId: string
}

/**
 * A form the reader can press Start on without touching the project picker in the common case:
 * one project means there is nothing to choose. Nothing is selected when the desktop reports no
 * projects, which `newChatProblem` then explains rather than the form silently looking fillable.
 */
export function initialNewChatForm(snapshot: RemoteWorkspaceSnapshot): NewChatForm {
  return { projectId: snapshot.projects[0]?.id ?? '', kind: 'claude', input: '', modelId: '' }
}

/**
 * The models this form may offer right now: the ones the *selected agent* was last seen to offer,
 * and nothing else. Empty is a normal state - a desktop that has not run that agent since install
 * knows nothing about it - and the caller renders "the desktop's default" rather than a dead
 * control.
 */
export function newChatModels(form: NewChatForm, catalogue: AgentModelCatalogue): AgentModel[] {
  return catalogue[form.kind] ?? []
}

/**
 * Switching agent has to drop a model chosen for the previous one: the two providers share no ids,
 * so carrying it over would send the host a model it is bound to refuse. Kept here rather than in
 * the view so the rule is the same wherever the kind changes.
 */
export function withNewChatKind(form: NewChatForm, kind: RemoteChatKind): NewChatForm {
  return kind === form.kind ? form : { ...form, kind, modelId: '' }
}

/**
 * The request this form would send. Trimming happens here rather than in the view so the rule that
 * decides whether there is a prompt at all is the same one that decides what gets sent.
 */
export function newChatRequest(form: NewChatForm): RemoteChatSpawnRequest {
  const input = form.input.trim()
  return {
    projectId: form.projectId,
    kind: form.kind,
    ...(input.length > 0 ? { input } : {}),
    // Omitted rather than sent empty: absent is the contract's word for "the desktop decides", and
    // an empty string would be a model id the host has to refuse.
    ...(form.modelId.length > 0 ? { modelId: form.modelId } : {})
  }
}

/**
 * Why this form cannot be submitted yet, or null. A project the snapshot no longer lists is called
 * out specifically: the host would refuse it anyway, and "pick a project" reads as a form the
 * reader forgot to fill in rather than one whose answer went away underneath them.
 */
export function newChatProblem(form: NewChatForm, snapshot: RemoteWorkspaceSnapshot): string | null {
  if (snapshot.projects.length === 0) return 'No projects are open on the desktop.'
  if (!snapshot.projects.some((project) => project.id === form.projectId)) {
    return form.projectId.length === 0 ? 'Pick a project first.' : 'That project is no longer open on the desktop.'
  }
  return remoteChatSpawnProblem(newChatRequest(form))
}

/** The agent kinds a phone may spawn, in the order the picker offers them. */
export const NEW_CHAT_KINDS: { kind: RemoteChatKind; label: string }[] = [
  { kind: 'claude', label: 'Claude' },
  { kind: 'codex', label: 'Codex' }
]

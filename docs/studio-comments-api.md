# Studio comments API

Review comments on a production's cuts. The owner watches a version in the
cut viewer, presses **C** at a moment and says what should change; an agent
picks the comment up, offers options with previews, and the owner accepts or
rejects them; the agent makes the accepted one, usually as a new version of
the production. This is the data and API behind it, for agents and for
Studio's Comments panel. The shapes are `mdmedia/threads`'
(`src/threads/types.ts`).

It sits beside the [productions API](studio-productions-api.md): same
authentication, errors and owner-only data. Previews and stills are ordinary
production media, uploaded through `PUT /api/v1/productions/media/{sha256}`.

## The model

| Firestore | What |
| --- | --- |
| `productions/{id}/threads/{threadId}` | A **thread**: one comment, anchored to a time on one version (cut), with its status and any claim. |
| `…/threads/{threadId}/messages/{messageId}` | A **message**: a reply. It may name a time on a video, offer options, or present a version. |
| `…/threads/{threadId}/suggestions/{suggestionId}` | A **suggestion** (an option): what an agent would do, with its previews, checks and state. |
| `productions/{id}/decisions/{decisionId}` | The production's **decision log**: decisions and standing constraints, linked to threads and versions. |
| `commentAgents/{id}` | An agent's **heartbeat**: it is watching for comments, on one production or all. |

Every document carries `ownerUid`. Rules let the owner read them all (a query
must filter on `ownerUid`), so the viewer listens live; no client writes
them. Only this API does, because only it can anchor a comment on the
resolved cut, check previews are the owner's media, and keep statuses in step.
Deleting a production deletes its threads and decisions (never its media).

**A thread's status** is one of:

- `open`: waiting for an agent: a new comment, the owner's reply, or an option the owner accepted and nobody has made yet;
- `in-progress`: an agent has claimed it;
- `addressed`: the agent answered, with options to choose from or a new version, and it waits for the owner;
- `resolved`: closed.

It follows the conversation: the owner's comment or reply, or accepting an
option, makes it `open`; a claim makes it `in-progress`; an agent's reply,
options or applied version make it `addressed`. `PATCH` sets it outright.
What the owner is asked to do is read from the options' states, never stored
twice; the API adds a one-line `statusLine` (`2 options to review`,
`Agent working`, `Addressed in Take 6`) the way Studio shows it.

**An option's state** is `proposed`, `accepted`, `rejected` or `applied`
(with `appliedAs`, the cut id of the version it became).

**Rounds.** Each time an agent offers options is a round: one message and its
options, lettered A, B, … in that round. Every video then has a plain label,
"Option A · round 2", never a file name; a preview after an option's first
carries its own `label` ("without the level ride").

**Times on videos.** A timed message names its video: a version
(`{ kind: "cut", cutId }`) or one of an option's previews
(`{ kind: "preview", suggestionId, assetId }`), and the time on it. On a cut,
the studio records the anchor too: the items under the playhead, with their
times then. A thread's own anchor is the same:

```json
{ "time": 21.8, "items": [
  { "kind": "segment", "id": "finish", "start": 21.13, "end": 27.31 },
  { "kind": "line", "id": "thisone", "start": 18.55, "end": 20.79 },
  { "kind": "line", "id": "wheels", "start": 21.68, "end": 22.42 },
  { "kind": "gap", "id": "thisone-wheels", "start": 20.79, "end": 21.68 },
  { "kind": "overlay", "id": "included", "start": 20.9, "end": 23.9 } ] }
```

Items are `anchorItems` (`src/threads/anchor.ts`): everything playing at the
playhead, lines timed by their speech; in a gap, the lines either side and
the gap; in a line, the line before it and the gap between.

## Authentication

As for the rest of `/api/v1`. Keys need these scopes; browser sessions have
both:

- `comments:read`: list and read threads, their context, and the decision log.
- `comments:write`: comment, reply, suggest, set states and statuses, claim, add decisions, and heartbeat.

An agent that suggests options also needs `productions:write`, to upload the
previews, and `productions:read` to fetch the media its context names. New
connections get every scope; existing keys are not widened: run
`mdmedia studio login` again.

## Endpoints

`P` is `/api/v1/productions/{id}`, `T` is `P/threads/{threadId}`.

| Method | Path | Scope | |
| --- | --- | --- | --- |
| `GET` | `P/threads?cutId=&needsAgent=1` | read | `{ threads }`: the production's threads (or one cut's) in timeline order, each with `statusLine` and `needsAgent` (open, or in progress with no live claim). |
| `POST` | `P/threads` | write | `{ cutId, time, text, range?, view?, frameAssetId?, agent? }`: a comment. Anchored server-side on the cut as it resolves now; `201`. |
| `GET` | `T` | read | `{ thread, messages, suggestions }`: everything, in order. |
| `PATCH` | `T` | write | `{ status }`: set the status outright. |
| `POST` | `T/messages` | write | `{ text, replyTo?, at?: { video, time }, version?: { cutId }, agent?, keepClaim? }`: a reply; `201`. |
| `POST` | `T/suggestions` | write | `{ message, suggestions: [...], agent?, round? }`: options, in a new round, offered by one message; `201`. |
| `PATCH` | `T/suggestions/{suggestionId}` | write | `{ state, appliedAs? }`: accept, reject, or mark applied as a version. |
| `POST` | `T/claim` | write | `{ agent, minutes? }`: take the thread for a while (default 20, at most 120); again to renew. Another agent's live claim is `409 claimed`. |
| `DELETE` | `T/claim` | write | End the claim; a thread still in progress goes back to `open`. |
| `GET` | `T/context` | read | The context bundle (below). |
| `GET` | `P/decisions` | read | `{ decisions, constraints }`, in order. |
| `POST` | `P/decisions` | write | `{ text, kind?, take?, source?, quote?, revised?, threadIds?, cutIds?, id? }`: add one at the end of the log; `201`. A taken id is `409 decision_exists`. |
| `POST` | `/api/v1/comments/heartbeat` | write | `{ agent, productionId? }`: this agent is watching. Studio says "Comments wait for an agent" when no heartbeat is under 3 minutes old. |

Errors are `{ "error": { "code", "message" } }`: `thread_not_found` and
`suggestion_not_found` (`404`), `cut_not_timed` (`422`, a rendered-only
version has no timeline to anchor on), `claimed` and `thread_resolved`
(`409`), and `invalid_*` (`400`) for a field that doesn't check out, such as
a time outside its video, a preview that isn't one of your videos, or an
`appliedAs` that isn't one of the production's cuts.

### Who writes

A browser session writes as `owner`. An API key writes as an agent,
`agent:<name>`, from the request's `agent` (default `agent`; lowercase
letters, digits and `-`). A key never writes as the owner.

### Writes and what they do to a thread

| Write | Thread |
| --- | --- |
| The owner comments, or replies | `open` |
| An agent claims | `in-progress`, claimed until `claim.expiresAt` |
| An agent replies or offers options | `addressed`; the claim ends (a reply with `keepClaim: true` keeps both) |
| The owner accepts an option | `open`, for an agent to make it |
| The owner rejects the last waiting option of a round | `open` |
| An agent marks an option applied | `addressed`; the claim ends |
| Release | `open` if it was in progress |

### Options

```json
{
  "agent": "editor",
  "message": "I read this as: the joke only works if Hal says it like \"They start!\". I recommend Option A.",
  "suggestions": [{
    "title": "One take from \"And this one?\" through \"save big!\"",
    "approach": "Replace the hood shot and the wide finish with one 8 s medium shot…",
    "steps": ["Storyboard …", "Generate three takes …", "Cut …"],
    "cost": { "generations": 3, "minutes": 40 },
    "risks": ["Ends on the medium, not the wide."],
    "checks": [{ "preview": "pm…", "passed": true, "verdicts": [{ "id": "one_delivery", "verdict": "one continuous delivery", "confidence": 0.95 }],
                 "pauses": [{ "between": "with -> wheels", "seconds": 0 }], "levels": [{ "phrase": "wheels!", "meanDb": -23.3 }], "notes": "…" }],
    "previews": [{ "assetId": "pm…" }, { "assetId": "pm…", "label": "without the level ride" }],
    "keeps": ["d3-premise", "d6-take4-review"],
    "overturns": ["d7-take5-method", "d9-wheels"],
    "creates": ["hal6-wheels-close-t1"],
    "revises": "s…"
  }]
}
```

- `message` is required: what the agent read in the comment and which option it recommends.
- Previews must be your uploaded videos; their lengths come from the upload.
- `checks` are kept as sent (verdicts and measured values), up to 200 KB.
- `round` adds to an existing round instead of starting the next.

## The context bundle

`GET T/context` answers with `mdmedia.thread-context@2`: everything an
agent needs to act on one thread, ported from `scripts/thread-context.ts` to
read Studio's data.

| Field | |
| --- | --- |
| `thread`, `messages`, `suggestions` | All of them, including folded rounds. |
| `writeTo` | The API paths for messages, suggestions, the claim and the status. |
| `production`, `version` | The version commented on: its label, length, size, fps, review note, render, the cut file it was pushed from, and `unchanged` (false once the cut was replaced). |
| `anchored` | The anchor's segments, lines, gaps and clips, as the cut is now. |
| `lines` | The anchored lines and their neighbours, in speaking order, with their words on the timeline and alignment. |
| `neighbours` | The shots either side of each anchored shot, with the cuts between them and the last and first words either side; the lines either side of each anchored line, with the gaps. |
| `decisions` | The log: `decisions`, `constraints`, and `relevant` (linked to this thread or version, naming an anchored item, or kept or overturned by an option). |
| `history` | The production's versions and the commented version's status and note. |
| `media` | Asset ids for the render, the still, the previews and the anchored takes, with their API links (`productions:read`). |
| `missing` | What the bundle needed and Studio doesn't have, and where it lives now. |

What the script read from the media root and Studio doesn't store is listed
in `missing`: how each take was generated (the generation log, storyboards,
first-frame stills, model and request ids); the other takes of each shot and
why they were circled or rejected; which shot a segment belongs to; first
and last frames of the anchored shots (Studio keeps one thumbnail per
segment); whole-take transcripts; generation costs; a renderer for a changed
cut; the characters' descriptions and references; the target running time.

## CLI

`mdmedia comments …` works through the connected studio (`mdmedia studio
login`, or `MDMEDIA_STUDIO_URL` and `MDMEDIA_API_KEY`). A production is its id
or slug. `--agent <name>` (or `MDMEDIA_AGENT`) signs an agent's writes;
`--json` prints JSON.

| Command | |
| --- | --- |
| `list <production> [--cut take5] [--waiting]` | Threads, one line each: id, version and time, status line. `--waiting`: only those that need an agent. |
| `show <production> <thread>` | The thread top to bottom, every message and option with its id, every time with its video. |
| `context <production> <thread> [-o file]` | The context bundle. |
| `claim <production> <thread> [--minutes 20] [--release]` | Take the thread, or let it go. |
| `reply <production> <thread> --text … [--at 15.0 [--video take6 \| --preview <suggestion>[:n]]] [--reply-to m…] [--version take6] [--keep-claim]` | Reply, at a time on the thread's cut, another cut or a preview; `--version` presents a version. |
| `suggest <production> <thread> --file options.json` | Offer options. The file is the body above, with `previews: [{ "file": "path.mp4", "label"? }]`; files are uploaded once each, by hash, relative to the file. |
| `state <production> <thread> <status>` | Set a thread's status. |
| `state <production> <thread> <suggestion> <state> [--as take6]` | Set an option's state; `applied` needs `--as`. |
| `decide <production> --text … [--kind constraint] [--take …] [--source …] [--quote …] [--thread …] [--cut …]`, `decide <production> --list` | Add to the decision log, or print it. |
| `heartbeat [--production big-hal] [--every 60]` | Say this agent is watching; `--every` keeps saying it. |

A typical turn: `list --waiting`, `claim`, `context`, work, then `suggest`
(or `reply`); after the owner accepts, make the version, push it
(`mdmedia production push`), `state … applied --as take6`, and
`reply --version take6` to present it.

## In Studio

The cut viewer (`/productions/{id}/cuts/{cutId}`) has a Comments panel
beside Now and Cut, and a pin on the timeline for each comment, coloured by
its status. **C** comments at the playhead (the anchor is shown in words,
"during “Wheels!” · finish shot", and a still of the frame is kept with it).
The panel lists the version's threads with one status line each, then the
selected thread: earlier rounds and turned-down options fold away, previews
play in place with their time and "Comment at this time", and options waiting
for the owner have Accept and Reject, each with a confirm step. Listeners
bring an agent's writes in as they happen. On a phone the panel follows the
timeline, after Now and Cut.

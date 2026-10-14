# Surfaces learnings

## A Surface is an instance, not a singleton feature

The initial design used `todo` as a singleton ID. Each Surface instead has a CUID2 identity and
a predefined type, allowing several independently named todo lists with optional managed images.
Todo operations require the instance ID under `/v0/surfaces/todo/:surfaceId` and cannot cross lists.

## Members belong inside their Surface

A separate response-level membership array duplicated relationships and complicated the model.
Each Surface now contains its member records, with each person's order key and join time.
An empty array alone means nobody joined; a standalone member remains an object using the existing
null user-ID convention. Joining and leaving change sidebar inclusion, never shared data.

## Administration is explicit and type-specific

Generic model creation hid differences between feature types. Active admin bots receive
`create_todo_surface`, with a name and optional image, and add/remove-user tools. Execution
rechecks authority; ordinary todo use cannot grant membership administration or create lists.

## Attribution is explicit and remains separate from audit actors

Todo records and Surfaces did not retain their author or creator. Todos now carry immutable
`authorUserId` in every snapshot and Surfaces carry immutable `creatorUserId`, using local Happy
user IDs or null. HTTP uses the authenticated caller; creation tools require an explicit ID or
null and never infer it from the agent's current message. Non-null IDs must identify existing
sign-in-capable team users. The explicit Surface creator joins its sidebar; team null creates
no member, while standalone null joins the local person. Older snapshots read as null without
inferring from members or revision actors or rewriting permanent history. Revision actors still
record the actual mutation context independently of attribution.

## Ordering reuses the existing implementation

Duplicating the workspace fractional-key helper was unnecessary. The algorithm now lives in a
shared utility used by tasks, bots, connections, subtasks, projects, workspaces, and Surfaces,
preserving its decimal format. New projects append fractional keys too; existing keys and
released migrations remain untouched.

New todos enter at the top through both HTTP and model tools, using a fractional key before the
first active item without rewriting its neighbours. Reactivating an existing todo remains a
different operation: it appends at the end with a fresh key, preserving the restoration rule.

## Section headings are a text convention, not another record type

An active todo beginning with exact `# ` is a section heading with no checkbox and does not count
as outstanding work. The daemon preserves the entire text without trimming or interpreting other
Markdown syntax. Creation, editing, ordering, state changes, and permanent history use the same
todo operations. Clients edit the full text so removing the prefix returns the row to an ordinary
task; historical row styling remains a client choice.

## Nothing historical is destroyed

The legacy list hard-deleted todos and allowed reorder to revive completed items. Every change
now appends an immutable full revision, including deletion and reorder. Inactive todos cannot
reorder, and restoration appends with a fresh key instead of recycling historical positions.

## Previous states use ordinary updates

Separate restore, revert, and unarchive commands duplicated state changes. History exposes the
immutable old values; the agent applies desired text and status with the current version through
ordinary update, and active placement through reorder. Lifecycle timestamps remain server-owned.

## Managed pictures share one normalization function

A Surface-specific normalizer duplicated node and bot WebP processing. All three now use one
shared managed-image function, while each module owns permissions, persistence, and error mapping.

## Deferred tools own their discovery descriptions

Shared capability text and missing keywords obscured the differences between Surface tools.
Every definition now declares its own concise capability and search terms directly, so listing,
editing, history, and administration can be found independently without a metadata wrapper.

## Auto review requires an action description on the tool

Surface mutation tools requested Auto review without describing their permission action, so
the runtime refused them before the reviewer ran. Every reviewed Surface tool now describes
its shared-data or membership write boundary. A structural check covers directly reviewable
module tools, and the real daemon gym proves that an approved edit commits while a denied edit
leaves the todo and its history unchanged. Review requirements and filesystem elevation remain
unchanged.

# Team

Team owns organization authentication, installation-local users, and their profiles. It also
announces the human sender to the model without changing user messages or public history. It is
registered in both modes: standalone has no members, but it does have guests.

```text
Authenticated user message -> Base consumes message -> Team system notification -> user text
                                                   -> current sender in agent KV
                                                   -> last notice in history KV
```

`TeamModule` installs its own transactional notification hook. Each human-authored message
selects its durable sender ID; each inference refreshes that sender's name and email. Unchanged
profile text is not repeated. History replacement clears only the announcement, so the next
safe boundary restores the profile. A missing or unknown human identity clears the previous
profile. System and agent-generated messages never select a human. Standalone installations
announce only guests, and the owner when they write after a guest in the same conversation.

Team authentication is either WorkOS (`WorkOSAccessTokenVerifier`) or a deployer's own JWTs
(`JwtAccessTokenVerifier`), selected by `feature.team.authentication`. Both yield the same
`TeamIdentity`: the method plus the user ID it issued. Users are keyed by that pair.
`authenticationMethods()` lists the OAuth code-flow sign-in the API advertises for JWT deployments.

A guest is a user whose authentication is `guest`: a person who reaches an exported bot from an
outside chat service. `createGuest` and `renameGuest` are the public seam the exported bots module
uses; a guest gets an opaque random subject, no email or photo, and is never the owner. No
verifier yields the `guest` method, `authenticate` and `currentUser` never resolve a guest, and
`connectionContext` refuses one, so a guest cannot sign in by any path. `listMembers` leaves
guests out for features that belong to people who sign in, such as personal Happy connections.
Every team member, owner or not, authorizes their own messages with the owner's authority; guests
are the one separate class, and authorize nothing.

`impl/teamSenderNotifications.ts` owns this bounded, transactional behavior. `persistence/` owns
user queries; profile changes continue through the existing identity-only public event surface.

# Surface model tools

One fixed common array serves every model. Todo operations name their Surface instance and use
current-version guards. A separate fixed admin array adds type-specific creation and user
administration only for actual active admin bots. Every mutation owns its permission policy.

Document tools read current or historical Markdown, replace the full text with a current-version
guard, and list bounded revision summaries. Reads skip review; updates require shared-data Auto
review without filesystem elevation. Document creation has the same optional managed-image
boundary as todo creation. Separators have no content or image tool.

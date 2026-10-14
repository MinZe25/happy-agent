# Surface model tools

One fixed common array serves every model. Todo operations name their Surface instance and use
current-version guards. A separate fixed admin array adds type-specific creation and user
administration only for actual active admin bots. Every mutation owns its permission policy.

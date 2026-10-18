# Observation learnings

## Debug history dumps are not an owner-authorized diagnostic surface

History dumps copied durable message objects wholesale, which would expose credential metadata
and configuration-only rows to a model or anyone receiving the dump. The dump now omits structured
error metadata and configuration blocks before serialization, skipping configuration-only rows.
Ordinary safe text and unrelated message fields remain intact; the durable history is unchanged.

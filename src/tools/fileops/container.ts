import { z } from "zod";

// Which storage tree the file tools address. Shared by all five so the wording
// a model reads is identical everywhere.
export const CONTAINER_SCHEMA = {
  container: z
    .enum(["files", "applications"])
    .optional()
    .default("files")
    .describe(
      "Storage tree to address. 'files' (default) is the data directory TI processes read from — Files on v12, Blobs on v11, flat on v11. 'applications' is the tree users see under Applications in Architect and PAW: it nests on both versions, and only its documents carry content (a view reference does not).",
    ),
};

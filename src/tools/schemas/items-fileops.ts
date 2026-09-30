// File-operation schemas: bare filename list item.
import { z } from "zod";

// listFiles returns bare strings (file/folder names).
export const FilenameItemSchema = z.string();

// The overwrite tools back up the replaced process under the user's home
// directory by default. Unit tests must not write there: backups are off for
// the whole suite, and tests that exercise them point TM1_PROCESS_BACKUP_DIR
// at a temp directory.
process.env.TM1_PROCESS_BACKUP_DIR = "off";

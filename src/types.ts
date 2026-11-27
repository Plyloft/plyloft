export type DirEntry = {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  /** The entry is a symlink, not followed (`files::DirEntry::is_symlink`). */
  isSymlink?: boolean;
};

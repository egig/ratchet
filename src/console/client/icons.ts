/**
 * The console's icon set — a single re-export point ("proxy") for the Heroicons 20px **solid**
 * ("mini") set, https://heroicons.com/solid. Every client component imports its icons from here
 * instead of reaching into `@heroicons/react` directly, so the underlying set — or any one glyph —
 * can be swapped in this one file without touching a single call site.
 *
 * Each export is a `React.SVGProps<SVGSVGElement>` component that paints in `currentColor` and
 * already carries `aria-hidden` (these sit next to a real text label, never alone). Size and
 * colour them with Tailwind classes:
 *
 *   <PlusIcon className="h-4 w-4" /> New
 *
 * Names are Heroicons' own, except for a few role-based aliases where the shape name would read
 * worse than the job the icon does at the call site (`FilterIcon`, `EditIcon`, …).
 */
export {
  PlusIcon,
  XMarkIcon,
  TrashIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  ChevronUpDownIcon,
  ArrowUpIcon,
  ArrowDownIcon,
  MagnifyingGlassIcon,
  PaperAirplaneIcon,
  StopIcon,
  SparklesIcon,
  WrenchIcon as ToolIcon,
  ArchiveBoxIcon,
  LockClosedIcon,
  LockOpenIcon,
  ArrowsUpDownIcon as SortIcon,
  FunnelIcon as FilterIcon,
  ViewColumnsIcon as ColumnsIcon,
  ArrowDownTrayIcon as ExportIcon,
  PencilSquareIcon as EditIcon,
  Cog6ToothIcon as SettingsIcon,
  ArrowLeftStartOnRectangleIcon as LogOutIcon,
  RectangleStackIcon as WorkspaceIcon,
  UserCircleIcon as ProfileIcon,
  Squares2X2Icon as ConsoleIcon,
  SunIcon,
  MoonIcon,
  BoltIcon,
  EyeIcon,
  PlusCircleIcon,
  ArrowsRightLeftIcon as BranchIcon,
  ArrowPathIcon as LoopIcon,
} from '@heroicons/react/20/solid';

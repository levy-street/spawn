import { type SFSymbol, SymbolView } from "expo-symbols";
import {
  AlertCircle,
  AlertTriangle,
  Archive,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowRightLeft,
  ArrowUp,
  Bell,
  BellOff,
  BellRing,
  Binary,
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsDownUp,
  ChevronUp,
  Clipboard,
  Copy,
  CornerUpLeft,
  Database,
  Download,
  Ellipsis,
  ExternalLink,
  Eye,
  EyeOff,
  File,
  FileArchive,
  FileCode,
  FileCog,
  FileImage,
  FileKey,
  FileMusic,
  FileSpreadsheet,
  FileSymlink,
  FileTerminal,
  FileText,
  FileType,
  FileVideoCamera,
  Fingerprint,
  Flame,
  Folder,
  FolderOpen,
  FolderPlus,
  FolderSearch,
  FolderTree,
  Home,
  ImageOff,
  ImagePlus,
  KeyRound,
  Laptop,
  LayoutTemplate,
  List,
  Loader2,
  Lock,
  LockOpen,
  LogOut,
  type LucideIcon,
  Mail,
  Maximize2,
  Menu,
  MessageCircleQuestion,
  MessageSquare,
  Monitor,
  MonitorSmartphone,
  Moon,
  MoreHorizontal,
  Network,
  Palette,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  PlugZap,
  Plus,
  Presentation,
  Radio,
  RadioTower,
  RefreshCw,
  RotateCcw,
  RotateCw,
  Search,
  Send,
  SendHorizontal,
  Server,
  Settings,
  Settings2,
  Shapes,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
  Skull,
  Smartphone,
  SquareTerminal,
  Sun,
  Terminal,
  Trash2,
  Type,
  Unlink,
  Unplug,
  Upload,
  User,
  UserRound,
  Volume2,
  Wrench,
  X,
  Zap,
} from "lucide-react-native";
import { View } from "react-native";

import { type Colors, useTheme } from "@/theme";

export const iconSet = {
  AlertCircle,
  AlertTriangle,
  Archive,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowRightLeft,
  ArrowUp,
  Bell,
  BellOff,
  BellRing,
  Binary,
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsDownUp,
  ChevronUp,
  Clipboard,
  Copy,
  CornerUpLeft,
  Database,
  Download,
  Ellipsis,
  ExternalLink,
  Eye,
  EyeOff,
  File,
  FileArchive,
  FileCode,
  FileCog,
  FileImage,
  FileKey,
  FileMusic,
  FileSpreadsheet,
  FileSymlink,
  FileTerminal,
  FileText,
  FileType,
  FileVideoCamera,
  Fingerprint,
  Flame,
  Folder,
  FolderOpen,
  FolderPlus,
  FolderSearch,
  FolderTree,
  Home,
  ImageOff,
  ImagePlus,
  KeyRound,
  Laptop,
  LayoutTemplate,
  List,
  Loader2,
  Lock,
  LockOpen,
  LogOut,
  Mail,
  Maximize2,
  Menu,
  MessageCircleQuestion,
  MessageSquare,
  Monitor,
  MonitorSmartphone,
  Moon,
  MoreHorizontal,
  Network,
  Palette,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  PlugZap,
  Plus,
  Presentation,
  Radio,
  RadioTower,
  RefreshCw,
  RotateCcw,
  RotateCw,
  Search,
  Send,
  SendHorizontal,
  Server,
  Settings,
  Settings2,
  Shapes,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
  Skull,
  Smartphone,
  SquareTerminal,
  Sun,
  Terminal,
  Trash2,
  Type,
  Unlink,
  Unplug,
  Upload,
  User,
  UserRound,
  Volume2,
  Wrench,
  X,
  Zap,
} as const satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof iconSet;

export type IconVariant = "brand" | "chrome";

const chromeSymbolSet: Partial<Record<IconName, SFSymbol>> = {
  Archive: "archivebox",
  ArrowDown: "arrow.down",
  ArrowLeft: "arrow.left",
  ArrowRight: "arrow.right",
  ArrowUp: "arrow.up",
  Check: "checkmark",
  ChevronDown: "chevron.down",
  ChevronLeft: "chevron.left",
  ChevronRight: "chevron.right",
  ChevronUp: "chevron.up",
  Clipboard: "doc.on.clipboard",
  Copy: "doc.on.doc",
  Download: "arrow.down.to.line",
  Ellipsis: "ellipsis",
  ExternalLink: "arrow.up.right.square",
  Folder: "folder",
  Home: "house",
  MoreHorizontal: "ellipsis",
  Pencil: "pencil",
  Plus: "plus",
  RefreshCw: "arrow.clockwise",
  RotateCcw: "arrow.counterclockwise",
  RotateCw: "arrow.clockwise",
  Search: "magnifyingglass",
  Settings: "gearshape",
  Settings2: "gearshape.2",
  Trash2: "trash",
  Upload: "square.and.arrow.up",
  X: "xmark",
};

export interface IconProps {
  accessibilityLabel?: string;
  color?: keyof Colors;
  name: IconName;
  size?: number;
  /** Apple chrome opts into SF Symbols; Spawn brand/domain imagery remains Lucide by default. */
  variant?: IconVariant;
  /** Allows a chrome caller with a more specific platform symbol to override the shared mapping. */
  symbol?: SFSymbol;
  testID?: string;
}

export function Icon({
  accessibilityLabel,
  color = "foreground",
  name,
  size,
  symbol,
  testID,
  variant = "brand",
}: IconProps) {
  const theme = useTheme();
  const IconGlyph = iconSet[name];
  const resolvedSize = size ?? theme.space(4);
  const fallback = (
    <IconGlyph
      accessibilityElementsHidden
      accessible={false}
      color={theme.colors[color]}
      size={resolvedSize}
    />
  );
  const symbolName = symbol ?? chromeSymbolSet[name];

  return (
    <View
      accessibilityElementsHidden={accessibilityLabel === undefined}
      accessibilityRole={accessibilityLabel === undefined ? undefined : "image"}
      accessible={accessibilityLabel !== undefined}
      style={{ height: resolvedSize, width: resolvedSize }}
      {...(accessibilityLabel === undefined ? {} : { accessibilityLabel })}
      {...(testID === undefined ? {} : { testID })}
    >
      {variant === "chrome" && symbolName ? (
        <SymbolView
          accessibilityElementsHidden
          accessible={false}
          fallback={fallback}
          name={symbolName}
          size={resolvedSize}
          tintColor={theme.colors[color]}
          type="monochrome"
          weight="regular"
        />
      ) : (
        fallback
      )}
    </View>
  );
}

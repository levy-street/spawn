import { Stack } from "expo-router";

import { ROUNDED_CARD_GESTURE_OPTIONS } from "@/components/nav/navigation-options";
import { useTheme } from "@/theme";

export interface DestinationStackProps {
  initialRouteName?: string;
}

/** A retained native stack hosted by one of the app's tab destinations. */
export function DestinationStack({ initialRouteName }: DestinationStackProps): React.JSX.Element {
  const theme = useTheme();

  return (
    <Stack
      {...(initialRouteName === undefined ? {} : { initialRouteName })}
      screenOptions={{
        ...ROUNDED_CARD_GESTURE_OPTIONS,
        // react-native-screens has shadow parity for its custom swipe, but no card-radius
        // option. Clipping the scene is safe here because app content already clears the
        // physical display corners through its header and bottom navigation insets.
        contentStyle: {
          backgroundColor: theme.colors.background,
          borderRadius: theme.radii.device,
          overflow: "hidden",
        },
        headerShown: false,
      }}
    />
  );
}

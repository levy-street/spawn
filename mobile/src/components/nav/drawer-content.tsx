import type { DrawerContentComponentProps } from "@react-navigation/drawer";
import { DrawerContentScrollView } from "@react-navigation/drawer";
import { type Href, useRouter } from "expo-router";
import { Pressable, StyleSheet, View } from "react-native";

import { Icon } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import { useMeQuery } from "@/data/queries/auth";
import { haptics } from "@/lib/haptics";
import { borderWidth, chrome, radii, spacing, useTheme } from "@/theme";
import {
  activeDrawerDestination,
  type DrawerDestination,
  drawerDestinations,
} from "./drawer-items";

interface DrawerRowProps {
  active: boolean;
  item: DrawerDestination;
  onPress: () => void;
}

function DrawerRow({ active, item, onPress }: DrawerRowProps): React.JSX.Element {
  const theme = useTheme();

  return (
    <Pressable
      accessibilityLabel={item.label}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={styles.hitArea}
      testID={`drawer-item-${item.id}`}
    >
      {({ pressed }) => {
        const emphasized = active || pressed;
        return (
          <View
            style={[styles.row, emphasized ? { backgroundColor: theme.colors.accent } : undefined]}
          >
            <View style={styles.iconSlot}>
              <Icon
                color={emphasized ? "foreground" : "mutedForeground"}
                name={item.icon}
                size={spacing[4]}
              />
            </View>
            <Text color={emphasized ? "foreground" : "mutedForeground"} variant="label">
              {item.label}
            </Text>
          </View>
        );
      }}
    </Pressable>
  );
}

export function SpawnDrawerContent(props: DrawerContentComponentProps): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const me = useMeQuery();
  const destinations = drawerDestinations(me.data?.user.is_admin === true);
  const routeName = props.state.routes[props.state.index]?.name ?? "";
  const activeId = activeDrawerDestination(routeName);

  const navigate = (item: DrawerDestination) => {
    haptics.selection();
    router.navigate(item.href as Href);
    props.navigation.closeDrawer();
  };

  const renderRows = (section: DrawerDestination["section"]) =>
    destinations
      .filter((item) => item.section === section)
      .map((item) => (
        <DrawerRow
          active={activeId === item.id}
          item={item}
          key={item.id}
          onPress={() => navigate(item)}
        />
      ));

  return (
    <DrawerContentScrollView
      {...props}
      contentContainerStyle={styles.content}
      style={{ backgroundColor: theme.colors.background }}
    >
      <View style={styles.brand}>
        <Text variant="label" weight="semibold">
          spawn
        </Text>
      </View>
      <View style={styles.main}>{renderRows("main")}</View>
      <View style={[styles.footer, { borderTopColor: theme.colors.border }]}>
        {renderRows("footer")}
      </View>
    </DrawerContentScrollView>
  );
}

const styles = StyleSheet.create({
  brand: {
    height: chrome.touchTarget,
    justifyContent: "center",
    paddingHorizontal: spacing[2.5],
  },
  content: {
    flexGrow: 1,
    paddingBottom: spacing[3],
    paddingTop: spacing[2.5],
  },
  footer: {
    borderTopWidth: borderWidth.hairline,
    marginHorizontal: spacing[2.5],
    marginTop: "auto",
    paddingTop: spacing[2],
  },
  hitArea: {
    height: chrome.touchTarget,
    justifyContent: "center",
  },
  iconSlot: {
    alignItems: "center",
    height: spacing[9],
    justifyContent: "center",
    width: spacing[9],
  },
  main: {
    marginHorizontal: spacing[2.5],
  },
  row: {
    alignItems: "center",
    borderRadius: radii.lg,
    flexDirection: "row",
    gap: spacing[2],
    height: chrome.rowHeight,
    paddingRight: spacing[3],
  },
});

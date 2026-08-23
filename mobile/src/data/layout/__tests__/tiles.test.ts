import {
  autoPlace,
  compactTiles,
  moveTile,
  readingOrderIds,
  removeTile,
  resizeTile,
  tilesFromSplitTree,
  validateGridLayout,
} from "@/data/layout/tiles";
import type { LegacySplitNode, Tile } from "@/data/types/layout";
import fixtureDocument from "../../../../tests/fixtures/layout-v3-fixtures.json";

interface FixtureCase {
  name: string;
  op: string;
  input: Record<string, unknown>;
  expected: unknown;
}

const cases = fixtureDocument.cases as FixtureCase[];

function fixtureTiles(input: Record<string, unknown>): Tile[] {
  return input["tiles"] as Tile[];
}

describe("shared LayoutV3 grid fixtures", () => {
  it.each(cases)("matches $name", ({ input, op, expected }) => {
    const before = JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
    let actual: unknown;

    switch (op) {
      case "validate":
        actual = validateGridLayout(input["layout"]);
        break;
      case "autoPlace":
        actual = autoPlace(fixtureTiles(input));
        break;
      case "move":
        actual = {
          tiles: moveTile(
            fixtureTiles(input),
            input["id"] as string,
            input["x"] as number,
            input["y"] as number,
          ),
        };
        break;
      case "resize":
        actual = {
          tiles: resizeTile(
            fixtureTiles(input),
            input["id"] as string,
            input["w"] as number,
            input["h"] as number,
          ),
        };
        break;
      case "remove":
        actual = { tiles: removeTile(fixtureTiles(input), input["id"] as string) };
        break;
      case "compact":
        actual = { tiles: compactTiles(fixtureTiles(input)) };
        break;
      case "readingOrder":
        actual = { order: readingOrderIds(fixtureTiles(input)) };
        break;
      case "fromSplitTree":
        actual = {
          tiles: tilesFromSplitTree(input["root"] as LegacySplitNode | null),
        };
        break;
      default:
        throw new Error(`Unknown fixture operation: ${op}`);
    }

    expect(actual).toEqual(expected);
    expect(input).toEqual(before);
  });
});

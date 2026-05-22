-module(spawnd_json).

-export([encode/1, decode/1, get/2, get/3, atomize/1]).

encode(Map) ->
    thoas:encode(Map).

decode(Bin) ->
    thoas:decode(Bin, #{return_maps => true}).

get(Key, Map) ->
    get(Key, Map, undefined).

get(Key, Map, Default) when is_map(Map) ->
    maps:get(key(Key), Map, Default).

atomize(Bin) when is_binary(Bin) ->
    binary_to_atom(Bin, utf8);
atomize(List) when is_list(List) ->
    list_to_atom(List).

key(Key) when is_atom(Key) ->
    atom_to_binary(Key, utf8);
key(Key) ->
    Key.

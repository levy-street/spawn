-module(spawnd_frames).

-export([encode/3, encode_output/2, decode/1]).

-define(KIND_OUTPUT, 16#01).
-define(KIND_INPUT, 16#02).

encode(Kind, AgentId, Payload) when is_integer(Kind), is_binary(Payload) ->
    <<Kind:8, (uuid_to_binary(AgentId))/binary, Payload/binary>>.

encode_output(AgentId, Payload) ->
    encode(?KIND_OUTPUT, AgentId, iolist_to_binary(Payload)).

decode(<<Kind:8, Uuid:16/binary, Payload/binary>>) ->
    {ok, Kind, uuid_from_binary(Uuid), Payload};
decode(_) ->
    {error, too_short}.

uuid_to_binary(Bin) when is_binary(Bin), byte_size(Bin) =:= 16 ->
    Bin;
uuid_to_binary(Text) when is_binary(Text) ->
    uuid_to_binary(binary_to_list(Text));
uuid_to_binary(Text) when is_list(Text) ->
    Hex = [C || C <- Text, C =/= $-],
    << <<(hex_pair_to_int(A, B)):8>> || [A, B] <- pairs(Hex) >>.

uuid_from_binary(<<A:32, B:16, C:16, D:16, E:48>>) ->
    list_to_binary(io_lib:format(
        "~8.16.0b-~4.16.0b-~4.16.0b-~4.16.0b-~12.16.0b",
        [A, B, C, D, E]
    )).

pairs([]) -> [];
pairs([A, B | Rest]) -> [[A, B] | pairs(Rest)].

hex_pair_to_int(A, B) ->
    hex_to_int(A) * 16 + hex_to_int(B).

hex_to_int(C) when C >= $0, C =< $9 -> C - $0;
hex_to_int(C) when C >= $a, C =< $f -> C - $a + 10;
hex_to_int(C) when C >= $A, C =< $F -> C - $A + 10.

-ifdef(TEST).
-include_lib("eunit/include/eunit.hrl").

round_trip_output_test() ->
    Id = <<"12345678-1234-5678-1234-567812345678">>,
    Payload = <<"hello">>,
    Frame = encode_output(Id, Payload),
    ?assertMatch({ok, ?KIND_OUTPUT, Id, Payload}, decode(Frame)).

rejects_short_frame_test() ->
    ?assertEqual({error, too_short}, decode(<<1, 2, 3>>)).
-endif.

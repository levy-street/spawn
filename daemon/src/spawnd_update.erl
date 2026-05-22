-module(spawnd_update).

-export([check/0, classify_git_state/1]).
-export([classify_service_update/2]).

check() ->
    case os:cmd("git status --porcelain=v1 2>/dev/null") of
        [] -> #{<<"ok">> => true, <<"clean">> => true};
        Output -> #{<<"ok">> => true, <<"clean">> => false, <<"changes">> => list_to_binary(Output)}
    end.

classify_git_state(<<>>) ->
    clean;
classify_git_state([]) ->
    clean;
classify_git_state(_) ->
    dirty.

classify_service_update(OldVersion, NewVersion) when OldVersion =:= NewVersion ->
    noop;
classify_service_update(_OldVersion, undefined) ->
    reject;
classify_service_update(_OldVersion, NewVersion) when is_binary(NewVersion); is_list(NewVersion) ->
    stage_then_restart.

-ifdef(TEST).
-include_lib("eunit/include/eunit.hrl").

classify_git_state_test() ->
    ?assertEqual(clean, classify_git_state(<<>>)),
    ?assertEqual(dirty, classify_git_state(<<" M src/file.erl\n">>)).

service_update_safety_classification_test() ->
    ?assertEqual(noop, classify_service_update(<<"0.2.0">>, <<"0.2.0">>)),
    ?assertEqual(reject, classify_service_update(<<"0.2.0">>, undefined)),
    ?assertEqual(stage_then_restart, classify_service_update(<<"0.2.0">>, <<"0.2.1">>)).
-endif.

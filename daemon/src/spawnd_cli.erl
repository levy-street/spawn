-module(spawnd_cli).

-export([main/1, main/0]).

main() ->
    main(init:get_plain_arguments()).

main(Args0) ->
    application:ensure_all_started(inets),
    application:ensure_all_started(ssl),
    {Server, Args} = take_server(Args0, undefined),
    case Args of
        ["--version" | _] ->
            io:format("spawnd 0.2.0~n"),
            halt(0);
        ["login" | Rest] ->
            HostName = option_value("--host-name", Rest, undefined),
            Result = spawnd_login:run(Server, HostName),
            halt_result(Result);
        ["run" | _] ->
            io:format(standard_error, "spawn: run must be started from the OTP release wrapper; use _build/default/rel/spawnd/bin/spawnd foreground in a dev checkout~n", []),
            halt(2);
        ["logout" | _] ->
            halt_result(spawnd_creds:logout());
        ["status" | _] ->
            halt_result(spawnd_creds:status(Server));
        ["agents" | _] ->
            print_json_result(remote_or_error(#{<<"command">> => <<"agents">>}));
        ["kill", AgentId | _] ->
            print_json_result(remote_or_error(#{<<"command">> => <<"kill">>, <<"agent_id">> => list_to_binary(AgentId)}));
        ["update-check" | _] ->
            print_json_result(remote_or_error(#{<<"command">> => <<"update-check">>}));
        ["self-test" | _] ->
            halt_result(self_test());
        _ ->
            usage(),
            halt(2)
    end.

take_server(["--server", Url | Rest], _Default) ->
    {list_to_binary(Url), Rest};
take_server([Arg | Rest], Default) ->
    {Server, Tail} = take_server(Rest, Default),
    {Server, [Arg | Tail]};
take_server([], Default) ->
    {Default, []}.

option_value(Opt, [Opt, Value | _], _Default) ->
    Value;
option_value(Opt, [_ | Rest], Default) ->
    option_value(Opt, Rest, Default);
option_value(_Opt, [], Default) ->
    Default.

print_json_result(Term) ->
    io:format("~s~n", [spawnd_json:encode(Term)]),
    halt(json_exit_code(Term)).

json_exit_code(#{<<"ok">> := false}) ->
    1;
json_exit_code(_) ->
    0.

remote_or_error(Request) ->
    case spawnd_control:request_remote(Request) of
        {ok, Reply} -> Reply;
        {error, Reason} -> #{<<"ok">> => false, <<"error">> => list_to_binary(io_lib:format("~p", [Reason]))}
    end.

halt_result(ok) ->
    halt(0);
halt_result({ok, _}) ->
    halt(0);
halt_result({error, Reason}) ->
    io:format(standard_error, "spawn: ~p~n", [Reason]),
    halt(1);
halt_result(Other) ->
    io:format(standard_error, "spawn: ~p~n", [Other]),
    halt(1).

usage() ->
    io:format("Usage: spawnd [--server URL] login|run|logout|status|agents|kill AGENT_ID|update-check|self-test~n").

self_test() ->
    case spawnd_control:request_remote(#{<<"command">> => <<"self-test">>}) of
        {ok, #{<<"ok">> := true}} -> ok;
        {ok, Reply} -> {error, Reply};
        Error -> Error
    end.

-ifdef(TEST).
-include_lib("eunit/include/eunit.hrl").

json_exit_code_reflects_ok_false_test() ->
    ?assertEqual(1, json_exit_code(#{<<"ok">> => false, <<"error">> => <<"nope">>})),
    ?assertEqual(0, json_exit_code(#{<<"ok">> => true})),
    ?assertEqual(0, json_exit_code(#{<<"agents">> => []})).
-endif.

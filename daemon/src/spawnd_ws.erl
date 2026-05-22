-module(spawnd_ws).
-behaviour(gen_server).

-include_lib("kernel/include/file.hrl").

-export([start_link/0, send_json/1, send_binary/1]).
-export([init/1, handle_call/3, handle_cast/2, handle_info/2, terminate/2, code_change/3]).

-define(HEARTBEAT_MS, 10000).
-define(HEARTBEAT_TIMEOUT_MS, 5000).
-define(INITIAL_RECONNECT_MS, 1000).
-define(MAX_RECONNECT_MS, 60000).
-define(KIND_INPUT, 16#02).

-record(state, {
    conn = undefined,
    stream = undefined,
    server = undefined,
    token = undefined,
    reconnect_ms = ?INITIAL_RECONNECT_MS,
    reconnect_timer = undefined,
    heartbeat_ref = undefined,
    heartbeat_timer = undefined
}).

start_link() ->
    gen_server:start_link({local, ?MODULE}, ?MODULE, [], []).

send_json(Map) ->
    case whereis(?MODULE) of
        undefined -> ok;
        Pid -> gen_server:cast(Pid, {send_json, Map})
    end.

send_binary(Bin) ->
    case whereis(?MODULE) of
        undefined -> ok;
        Pid -> gen_server:cast(Pid, {send_binary, Bin})
    end.

init([]) ->
    process_flag(trap_exit, true),
    application:ensure_all_started(gun),
    erlang:send_after(0, self(), connect),
    {ok, #state{}}.

handle_call(_Req, _From, State) ->
    {reply, ok, State}.

handle_cast({send_json, Map}, State = #state{conn = Conn, stream = Stream}) when Conn =/= undefined ->
    gun:ws_send(Conn, Stream, {text, iolist_to_binary(spawnd_json:encode(Map))}),
    {noreply, State};
handle_cast({send_binary, Bin}, State = #state{conn = Conn, stream = Stream}) when Conn =/= undefined ->
    gun:ws_send(Conn, Stream, {binary, Bin}),
    {noreply, State};
handle_cast(_Msg, State) ->
    {noreply, State}.

handle_info(connect, State = #state{conn = undefined}) ->
    {noreply, connect(State#state{reconnect_timer = undefined})};
handle_info(connect, State) ->
    {noreply, State#state{reconnect_timer = undefined}};
handle_info(heartbeat, State = #state{conn = undefined}) ->
    {noreply, schedule_reconnect(State)};
handle_info(heartbeat, State) ->
    send_json(#{<<"type">> => <<"host.heartbeat">>}),
    erlang:send_after(?HEARTBEAT_MS, self(), heartbeat),
    {noreply, schedule_heartbeat_timeout(State)};
handle_info({heartbeat_timeout, Ref}, State = #state{heartbeat_ref = Ref}) ->
    {noreply, reset_and_reconnect(State)};
handle_info({heartbeat_timeout, _Ref}, State) ->
    {noreply, State};
handle_info({gun_upgrade, Conn, Stream, [<<"websocket">>], _Headers}, State = #state{conn = Conn, stream = Stream}) ->
    register_host(),
    erlang:send_after(?HEARTBEAT_MS, self(), heartbeat),
    {noreply, reset_backoff(State)};
handle_info({gun_response, _Conn, _Stream, _IsFin, Status, _Headers}, State) ->
    io:format(standard_error, "spawn: websocket upgrade failed: ~p~n", [Status]),
    {noreply, reset_and_reconnect(State)};
handle_info({gun_error, _Conn, _Stream, Reason}, State) ->
    io:format(standard_error, "spawn: websocket error: ~p~n", [Reason]),
    {noreply, reset_and_reconnect(State)};
handle_info({gun_down, _Conn, _Proto, _Reason, _Killed, _Unprocessed}, State) ->
    {noreply, reset_and_reconnect(State)};
handle_info({gun_ws, _Conn, _Stream, {text, Bin}}, State) ->
    case handle_text(Bin) of
        heartbeat_ack -> {noreply, cancel_heartbeat_timeout(State)};
        _ -> {noreply, State}
    end;
handle_info({gun_ws, _Conn, _Stream, {binary, Bin}}, State) ->
    handle_binary(Bin),
    {noreply, State};
handle_info({gun_ws, _Conn, _Stream, close}, State) ->
    {noreply, reset_and_reconnect(State)};
handle_info({gun_ws, _Conn, _Stream, {close, _Code, _Reason}}, State) ->
    {noreply, reset_and_reconnect(State)};
handle_info(_Msg, State) ->
    {noreply, State}.

terminate(_Reason, #state{conn = undefined}) ->
    ok;
terminate(_Reason, #state{conn = Conn}) ->
    catch gun:close(Conn),
    ok.

code_change(_OldVsn, State, _Extra) ->
    {ok, State}.

connect(State) ->
    Creds = spawnd_creds:load(),
    Token = maps:get(<<"access_token">>, Creds, undefined),
    Server =
        case os:getenv("SPAWN_SERVER_URL") of
            false -> maps:get(<<"server_url">>, Creds, spawnd_config:server_url(undefined));
            EnvServer -> spawnd_config:server_url(EnvServer)
        end,
    case Token of
        undefined ->
            schedule_reconnect(State#state{server = Server, token = Token});
        <<>> ->
            schedule_reconnect(State#state{server = Server, token = Token});
        _ ->
            WsUrl = spawnd_config:ws_url(Server),
            case open_ws(WsUrl, Token) of
                {ok, Conn, Stream} ->
                    State#state{conn = Conn, stream = Stream, server = Server, token = Token};
                {error, Reason} ->
                    io:format(standard_error, "spawn: connect failed: ~p~n", [Reason]),
                    schedule_reconnect(State#state{server = Server, token = Token})
            end
    end.

open_ws(WsUrl, Token) ->
    Uri = uri_string:parse(binary_to_list(WsUrl)),
    Host = maps:get(host, Uri),
    Scheme = maps:get(scheme, Uri),
    Port = maps:get(port, Uri, default_port(Scheme)),
    Path0 = maps:get(path, Uri, "/ws/daemon"),
    Path = case maps:get(query, Uri, undefined) of
        undefined -> Path0;
        Query -> Path0 ++ "?" ++ Query
    end,
    Transport = case Scheme of "wss" -> tls; _ -> tcp end,
    case gun:open(Host, Port, #{transport => Transport, protocols => [http]}) of
        {ok, Conn} ->
            case gun:await_up(Conn, 10000) of
                {ok, _Proto} ->
                    Headers = [
                        {<<"authorization">>, <<"Bearer ", Token/binary>>}
                    ],
                    Stream = gun:ws_upgrade(Conn, Path, Headers, #{
                        protocols => [{<<"spawn.v1">>, gun_ws_h}]
                    }),
                    {ok, Conn, Stream};
                Error ->
                    {error, Error}
            end;
        Error ->
            Error
    end.

default_port("wss") -> 443;
default_port("ws") -> 80.

reset_and_reconnect(State = #state{conn = Conn}) ->
    State1 = cancel_heartbeat_timeout(State),
    catch gun:close(Conn),
    schedule_reconnect(State1#state{conn = undefined, stream = undefined}).

schedule_reconnect(State = #state{reconnect_timer = Timer}) when Timer =/= undefined ->
    State;
schedule_reconnect(State = #state{reconnect_ms = Delay}) ->
    Timer = erlang:send_after(Delay, self(), connect),
    State#state{reconnect_ms = next_reconnect_ms(Delay), reconnect_timer = Timer}.

reset_backoff(State) ->
    State#state{reconnect_ms = ?INITIAL_RECONNECT_MS, reconnect_timer = undefined}.

next_reconnect_ms(Delay) when Delay >= ?MAX_RECONNECT_MS ->
    ?MAX_RECONNECT_MS;
next_reconnect_ms(Delay) ->
    min(Delay * 2, ?MAX_RECONNECT_MS).

schedule_heartbeat_timeout(State0) ->
    State = cancel_heartbeat_timeout(State0),
    Ref = make_ref(),
    Timer = erlang:send_after(?HEARTBEAT_TIMEOUT_MS, self(), {heartbeat_timeout, Ref}),
    State#state{heartbeat_ref = Ref, heartbeat_timer = Timer}.

cancel_heartbeat_timeout(State = #state{heartbeat_timer = undefined}) ->
    State#state{heartbeat_ref = undefined};
cancel_heartbeat_timeout(State = #state{heartbeat_timer = Timer}) ->
    _ = erlang:cancel_timer(Timer),
    State#state{heartbeat_ref = undefined, heartbeat_timer = undefined}.

register_host() ->
    Host = host_name(),
    send_json(#{
        <<"type">> => <<"register">>,
        <<"host_name">> => Host,
        <<"os">> => os_name(),
        <<"arch">> => list_to_binary(erlang:system_info(system_architecture)),
        <<"version">> => <<"0.2.0">>,
        <<"home_dir">> => list_to_binary(spawnd_config:home_dir()),
        <<"existing_agents">> => spawnd_registry:ids()
    }).

handle_text(Bin) ->
    case spawnd_json:decode(Bin) of
        {ok, #{<<"type">> := <<"host.heartbeat">>}} -> heartbeat_ack;
        {ok, Obj} -> dispatch(Obj);
        _ -> ok
    end.

dispatch(#{<<"type">> := <<"registered">>}) ->
    ok;
dispatch(Obj = #{<<"type">> := <<"host.fs.list">>}) ->
    Req = maps:get(<<"request_id">>, Obj),
    Result = spawnd_host:fs_list(maps:get(<<"path">>, Obj, undefined)),
    send_json(Result#{
        <<"type">> => <<"host.fs.list_result">>,
        <<"request_id">> => Req
    });
dispatch(Obj = #{<<"type">> := <<"host.tools.check">>}) ->
    Req = maps:get(<<"request_id">>, Obj),
    Targets = maps:get(<<"targets">>, Obj, []),
    send_json(#{
        <<"type">> => <<"host.tools.check_result">>,
        <<"request_id">> => Req,
        <<"tools">> => spawnd_host:tools_check(Targets)
    });
dispatch(Obj = #{<<"type">> := <<"host.tools.install">>}) ->
    Req = maps:get(<<"request_id">>, Obj),
    Target = maps:get(<<"target">>, Obj, #{}),
    send_json(#{
        <<"type">> => <<"host.tools.install_result">>,
        <<"request_id">> => Req,
        <<"result">> => safe_tool_install(Target)
    });
dispatch(Obj = #{<<"type">> := <<"host.daemon.status">>}) ->
    Req = maps:get(<<"request_id">>, Obj),
    Status = spawnd_registry:status(),
    send_json(Status#{
        <<"type">> => <<"host.daemon.status_result">>,
        <<"request_id">> => Req,
        <<"status">> => <<"online">>,
        <<"update">> => spawnd_update:check()
    });
dispatch(Obj = #{<<"type">> := Type}) when Type =:= <<"agent.create">>; Type =:= <<"agent.restart">> ->
    AgentId = maps:get(<<"agent_id">>, Obj),
    Cwd = maps:get(<<"cwd">>, Obj, spawnd_config:home_dir()),
    _ = maybe_create_cwd(maps:get(<<"create_cwd">>, Obj, false), Cwd),
    Spec = #{
        argv => maps:get(<<"argv">>, Obj, []),
        cwd => Cwd,
        env => maps:get(<<"env">>, Obj, #{}),
        cols => maps:get(<<"cols">>, Obj, 120),
        rows => maps:get(<<"rows">>, Obj, 32)
    },
    case ensure_agent_executable(Obj) of
        ok ->
            Result = case Type of
                <<"agent.restart">> -> spawnd_registry:restart(AgentId, Spec);
                _ -> spawnd_registry:create(AgentId, Spec)
            end,
            case Result of
                {ok, _Pid} -> ok;
                Error -> send_error(AgentId, <<"spawn_failed">>, io_lib:format("~p", [Error]))
            end;
        {error, Reason} ->
            send_error(AgentId, <<"spawn_failed">>, Reason)
    end;
dispatch(#{<<"type">> := <<"agent.kill">>, <<"agent_id">> := AgentId}) ->
    kill_existing(AgentId);
dispatch(#{<<"type">> := <<"agent.resize">>, <<"agent_id">> := AgentId, <<"cols">> := Cols, <<"rows">> := Rows}) ->
    with_agent(AgentId, fun(Pid) -> spawnd_agent:resize(Pid, Cols, Rows) end);
dispatch(#{<<"type">> := <<"agent.scroll">>}) ->
    ok;
dispatch(Obj = #{<<"type">> := <<"agent.snapshot">>, <<"agent_id">> := AgentId}) ->
    Lines = maps:get(<<"lines">>, Obj, 5000),
    with_agent(AgentId, fun(Pid) ->
        Bytes = spawnd_agent:snapshot(Pid, Lines),
        Reply0 = #{
            <<"type">> => <<"agent.snapshot">>,
            <<"agent_id">> => AgentId,
            <<"bytes_b64">> => base64:encode(Bytes)
        },
        Reply =
            case maps:get(<<"request_id">>, Obj, undefined) of
                undefined -> Reply0;
                Req -> Reply0#{<<"request_id">> => Req}
            end,
        send_json(Reply)
    end);
dispatch(#{<<"type">> := <<"agent.redraw">>, <<"agent_id">> := AgentId}) ->
    with_agent(AgentId, fun(Pid) -> spawnd_agent:redraw(Pid) end);
dispatch(Obj = #{<<"type">> := <<"agent.upload">>, <<"agent_id">> := AgentId}) ->
    with_agent(AgentId, fun(Pid) ->
        case catch spawnd_host:save_upload(Obj) of
            Path when is_binary(Path) ->
                case maps:get(<<"paste">>, Obj, true) of
                    false ->
                        ok;
                    _ ->
                        Prefix = upload_paste_prefix(Obj),
                        spawnd_agent:stdin(Pid, <<Prefix/binary, Path/binary>>)
                end,
                send_json(#{
                    <<"type">> => <<"agent.uploaded">>,
                    <<"agent_id">> => AgentId,
                    <<"path">> => Path,
                    <<"client_id">> => maps:get(<<"client_id">>, Obj, null)
                });
            {'EXIT', Reason} ->
                send_error(AgentId, <<"upload_failed">>, io_lib:format("~p", [Reason]))
        end
    end);
dispatch(_Obj) ->
    ok.

handle_binary(Bin) ->
    case spawnd_frames:decode(Bin) of
        {ok, ?KIND_INPUT, AgentId, Payload} ->
            with_agent(AgentId, fun(Pid) -> spawnd_agent:stdin(Pid, Payload) end);
        _ ->
            ok
    end.

with_agent(AgentId, Fun) ->
    case spawnd_registry:lookup(AgentId) of
        {ok, Pid} -> Fun(Pid);
        not_found -> ok
    end.

kill_existing(AgentId) ->
    with_agent(AgentId, fun(Pid) -> spawnd_agent:stop_agent(Pid) end).

send_error(AgentId, Code, Message) ->
    send_json(#{
        <<"type">> => <<"error">>,
        <<"agent_id">> => AgentId,
        <<"code">> => Code,
        <<"message">> => iolist_to_binary(Message)
    }).

upload_paste_prefix(Obj) ->
    case maps:get(<<"paste_prefix">>, Obj, <<>>) of
        Prefix when is_binary(Prefix) -> Prefix;
        _ -> <<>>
    end.

safe_tool_install(Target) ->
    case catch spawnd_host:tool_install(Target) of
        Result when is_map(Result) ->
            Result;
        {'EXIT', Reason} ->
            #{
                <<"preset_id">> => maps:get(<<"preset_id">>, Target, <<>>),
                <<"preset_name">> => maps:get(<<"preset_name">>, Target, <<>>),
                <<"agent_kind">> => maps:get(<<"agent_kind">>, Target, <<>>),
                <<"command">> => maps:get(<<"command">>, Target, <<>>),
                <<"install">> => maps:get(<<"install">>, Target, null),
                <<"success">> => false,
                <<"exit_code">> => null,
                <<"output">> => <<>>,
                <<"error">> => iolist_to_binary(io_lib:format("~p", [Reason]))
            }
    end.

maybe_create_cwd(true, Cwd) ->
    filelib:ensure_dir(filename:join(spawnd_host:expand_path(Cwd), "x"));
maybe_create_cwd(_, _) ->
    ok.

ensure_agent_executable(Obj = #{<<"argv">> := [Exe | _], <<"install">> := Install}) ->
    Env = env_list(maps:get(<<"env">>, Obj, #{})),
    case executable_exists(Exe, Env) of
        true -> ok;
        false when is_binary(Install), byte_size(Install) > 0 ->
            _ = spawnd_host:tool_install(#{
                <<"preset_id">> => maps:get(<<"preset_id">>, Obj, <<>>),
                <<"preset_name">> => maps:get(<<"preset_name">>, Obj, <<>>),
                <<"agent_kind">> => maps:get(<<"agent_kind">>, Obj, <<>>),
                <<"command">> => Exe,
                <<"install">> => Install
            }),
            case executable_exists(Exe, Env) of
                true -> ok;
                false -> {error, <<"install completed but executable is still not on PATH">>}
            end;
        false ->
            {error, <<"executable not found and no install command is configured">>}
    end;
ensure_agent_executable(Obj = #{<<"argv">> := [Exe | _]}) ->
    Env = env_list(maps:get(<<"env">>, Obj, #{})),
    case executable_exists(Exe, Env) of
        true -> ok;
        false -> {error, <<"executable not found">>}
    end;
ensure_agent_executable(_) ->
    {error, <<"argv is empty">>}.

executable_exists(Exe0, Env) ->
    spawnd_host:resolve_executable(Exe0, Env) =/= false.

env_list(Env) when is_map(Env) ->
    [{binary_or_list(K), binary_or_list(V)} || {K, V} <- maps:to_list(Env)];
env_list(Env) when is_list(Env) ->
    [{binary_or_list(K), binary_or_list(V)} || {K, V} <- Env];
env_list(_) ->
    [].

binary_or_list(Bin) when is_binary(Bin) ->
    binary_to_list(Bin);
binary_or_list(List) when is_list(List) ->
    List;
binary_or_list(Other) ->
    binary_to_list(iolist_to_binary(io_lib:format("~p", [Other]))).

host_name() ->
    case inet:gethostname() of
        {ok, Name} -> list_to_binary(Name);
        _ -> <<"unknown-host">>
    end.

os_name() ->
    {Family, Name} = os:type(),
    list_to_binary(io_lib:format("~p/~p", [Family, Name])).

-ifdef(TEST).
-include_lib("eunit/include/eunit.hrl").

ensure_agent_executable_uses_agent_path_env_test() ->
    Base = filename:join(
        os:getenv("TMPDIR", "/tmp"),
        "spawnd-ws-path-" ++ integer_to_list(erlang:unique_integer([positive]))
    ),
    ok = filelib:ensure_dir(filename:join(Base, "x")),
    Command = "spawnd-ws-path-command",
    Script = filename:join(Base, Command),
    ok = file:write_file(Script, <<"#!/bin/sh\nexit 0\n">>),
    ok = file:change_mode(Script, 8#755),
    OldPath = os:getenv("PATH"),
    try
        ?assertEqual(
            ok,
            ensure_agent_executable(#{
                <<"argv">> => [list_to_binary(Command)],
                <<"env">> => #{<<"PATH">> => list_to_binary(Base ++ ":" ++ path_or_empty(OldPath))},
                <<"install">> => <<"false">>
            })
        )
    after
        _ = file:del_dir_r(Base)
    end.

ensure_agent_executable_reports_missing_command_test() ->
    Missing = <<
        "spawnd-ws-missing-command-",
        (integer_to_binary(erlang:unique_integer([positive])))/binary
    >>,
    ?assertMatch(
        {error, <<"executable not found", _/binary>>},
        ensure_agent_executable(#{<<"argv">> => [Missing], <<"env">> => #{}})
    ).

next_reconnect_ms_uses_exponential_cap_test() ->
    ?assertEqual(2000, next_reconnect_ms(1000)),
    ?assertEqual(4000, next_reconnect_ms(2000)),
    ?assertEqual(60000, next_reconnect_ms(32000)),
    ?assertEqual(60000, next_reconnect_ms(60000)),
    ?assertEqual(60000, next_reconnect_ms(120000)).

schedule_reconnect_does_not_queue_duplicate_connects_test() ->
    State1 = schedule_reconnect(#state{reconnect_ms = 1}),
    State2 = schedule_reconnect(State1),
    ?assertEqual(State1#state.reconnect_timer, State2#state.reconnect_timer),
    receive
        connect -> ok
    after 100 ->
        ?assert(false)
    end,
    receive
        connect -> ?assert(false)
    after 20 ->
        ok
    end.

stale_connect_timer_is_ignored_when_connected_test() ->
    {noreply, State} = handle_info(connect, #state{conn = connected, reconnect_timer = timer}),
    ?assertEqual(connected, State#state.conn),
    ?assertEqual(undefined, State#state.reconnect_timer).

path_or_empty(false) ->
    "";
path_or_empty(Path) ->
    Path.
-endif.

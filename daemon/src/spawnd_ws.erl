-module(spawnd_ws).
-behaviour(gen_server).

-export([start_link/0, send_json/1, send_binary/1]).
-export([init/1, handle_call/3, handle_cast/2, handle_info/2, terminate/2, code_change/3]).

-define(HEARTBEAT_MS, 30000).
-define(RECONNECT_MS, 2000).
-define(KIND_INPUT, 16#02).

-record(state, {
    conn = undefined,
    stream = undefined,
    server = undefined,
    token = undefined
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

handle_info(connect, State) ->
    {noreply, connect(State)};
handle_info(heartbeat, State = #state{conn = undefined}) ->
    erlang:send_after(?RECONNECT_MS, self(), connect),
    {noreply, State};
handle_info(heartbeat, State) ->
    send_json(#{<<"type">> => <<"host.heartbeat">>}),
    erlang:send_after(?HEARTBEAT_MS, self(), heartbeat),
    {noreply, State};
handle_info({gun_upgrade, Conn, Stream, [<<"websocket">>], _Headers}, State = #state{conn = Conn, stream = Stream}) ->
    register_host(),
    erlang:send_after(?HEARTBEAT_MS, self(), heartbeat),
    {noreply, State};
handle_info({gun_response, _Conn, _Stream, _IsFin, Status, _Headers}, State) ->
    io:format(standard_error, "spawn: websocket upgrade failed: ~p~n", [Status]),
    {noreply, reset_and_reconnect(State)};
handle_info({gun_error, _Conn, _Stream, Reason}, State) ->
    io:format(standard_error, "spawn: websocket error: ~p~n", [Reason]),
    {noreply, reset_and_reconnect(State)};
handle_info({gun_down, _Conn, _Proto, _Reason, _Killed, _Unprocessed}, State) ->
    {noreply, reset_and_reconnect(State)};
handle_info({gun_ws, _Conn, _Stream, {text, Bin}}, State) ->
    handle_text(Bin),
    {noreply, State};
handle_info({gun_ws, _Conn, _Stream, {binary, Bin}}, State) ->
    handle_binary(Bin),
    {noreply, State};
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
            erlang:send_after(?RECONNECT_MS, self(), connect),
            State#state{server = Server, token = Token};
        <<>> ->
            erlang:send_after(?RECONNECT_MS, self(), connect),
            State#state{server = Server, token = Token};
        _ ->
            WsUrl = spawnd_config:ws_url(Server),
            case open_ws(WsUrl, Token) of
                {ok, Conn, Stream} ->
                    State#state{conn = Conn, stream = Stream, server = Server, token = Token};
                {error, Reason} ->
                    io:format(standard_error, "spawn: connect failed: ~p~n", [Reason]),
                    erlang:send_after(?RECONNECT_MS, self(), connect),
                    State#state{server = Server, token = Token}
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
                        {<<"authorization">>, <<"Bearer ", Token/binary>>},
                        {<<"sec-websocket-protocol">>, <<"spawn.v1">>}
                    ],
                    Stream = gun:ws_upgrade(Conn, Path, Headers),
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
    catch gun:close(Conn),
    erlang:send_after(?RECONNECT_MS, self(), connect),
    State#state{conn = undefined, stream = undefined}.

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
        {ok, Obj} -> dispatch(Obj);
        _ -> ok
    end.

dispatch(#{<<"type">> := <<"registered">>}) ->
    ok;
dispatch(#{<<"type">> := <<"host.heartbeat">>}) ->
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
        <<"result">> => spawnd_host:tool_install(Target)
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
    case Type of
        <<"agent.restart">> -> kill_existing(AgentId);
        _ -> ok
    end,
    case ensure_agent_executable(Obj) of
        ok ->
            case spawnd_registry:create(AgentId, Spec) of
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
        send_json(#{
            <<"type">> => <<"agent.snapshot">>,
            <<"agent_id">> => AgentId,
            <<"bytes_b64">> => base64:encode(Bytes)
        })
    end);
dispatch(#{<<"type">> := <<"agent.redraw">>, <<"agent_id">> := AgentId}) ->
    with_agent(AgentId, fun(Pid) -> spawnd_agent:redraw(Pid) end);
dispatch(Obj = #{<<"type">> := <<"agent.upload">>, <<"agent_id">> := AgentId}) ->
    with_agent(AgentId, fun(Pid) ->
        Path = spawnd_host:save_upload(Obj),
        case maps:get(<<"paste">>, Obj, true) of
            false -> ok;
            _ -> spawnd_agent:stdin(Pid, Path)
        end,
        send_json(#{
            <<"type">> => <<"agent.uploaded">>,
            <<"agent_id">> => AgentId,
            <<"path">> => Path,
            <<"client_id">> => maps:get(<<"client_id">>, Obj, null)
        })
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

maybe_create_cwd(true, Cwd) ->
    filelib:ensure_dir(filename:join(spawnd_host:expand_path(Cwd), "x"));
maybe_create_cwd(_, _) ->
    ok.

ensure_agent_executable(#{<<"argv">> := [Exe | _], <<"install">> := Install}) ->
    case executable_exists(Exe) of
        true -> ok;
        false when is_binary(Install), byte_size(Install) > 0 ->
            _ = os:cmd(binary_to_list(Install) ++ " 2>&1"),
            case executable_exists(Exe) of
                true -> ok;
                false -> {error, <<"install completed but executable is still not on PATH">>}
            end;
        false ->
            {error, <<"executable not found and no install command is configured">>}
    end;
ensure_agent_executable(#{<<"argv">> := [Exe | _]}) ->
    case executable_exists(Exe) of
        true -> ok;
        false -> {error, <<"executable not found">>}
    end;
ensure_agent_executable(_) ->
    {error, <<"argv is empty">>}.

executable_exists(Exe0) ->
    Exe = case is_binary(Exe0) of true -> binary_to_list(Exe0); false -> Exe0 end,
    case filename:pathtype(Exe) of
        absolute -> filelib:is_file(Exe);
        _ -> os:find_executable(Exe) =/= false
    end.

host_name() ->
    case inet:gethostname() of
        {ok, Name} -> list_to_binary(Name);
        _ -> <<"unknown-host">>
    end.

os_name() ->
    {Family, Name} = os:type(),
    list_to_binary(io_lib:format("~p/~p", [Family, Name])).

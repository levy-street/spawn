use util::vnet::*;
use util::Conn;
use waitgroup::WaitGroup;

use super::agent_vnet_test::*;
use super::*;
use crate::agent::agent_transport::AgentConn;

struct RouteFailureConn {
    socket: tokio::net::UdpSocket,
    failure: std::sync::Mutex<Option<std::io::ErrorKind>>,
}

#[async_trait::async_trait]
impl Conn for RouteFailureConn {
    async fn connect(&self, addr: SocketAddr) -> util::Result<()> {
        Ok(self.socket.connect(addr).await?)
    }
    async fn recv(&self, buf: &mut [u8]) -> util::Result<usize> {
        Ok(self.socket.recv(buf).await?)
    }
    async fn recv_from(&self, buf: &mut [u8]) -> util::Result<(usize, SocketAddr)> {
        Ok(self.socket.recv_from(buf).await?)
    }
    async fn send(&self, buf: &[u8]) -> util::Result<usize> {
        Ok(self.socket.send(buf).await?)
    }
    async fn send_to(&self, buf: &[u8], target: SocketAddr) -> util::Result<usize> {
        if let Some(kind) = self.failure.lock().unwrap().take() {
            return Err(std::io::Error::from(kind).into());
        }
        Ok(self.socket.send_to(buf, target).await?)
    }
    fn local_addr(&self) -> util::Result<SocketAddr> {
        Ok(self.socket.local_addr()?)
    }
    fn remote_addr(&self) -> Option<SocketAddr> {
        None
    }
    async fn close(&self) -> util::Result<()> {
        Ok(())
    }
    fn as_any(&self) -> &(dyn std::any::Any + Send + Sync) {
        self
    }
}

#[tokio::test]
async fn unavailable_route_drops_one_datagram_and_recovers_without_closing() -> Result<()> {
    use crate::candidate::candidate_base::CandidateBaseConfig;
    use crate::candidate::candidate_host::CandidateHostConfig;
    use std::io::ErrorKind;

    for selected in [false, true] {
        for kind in [
            ErrorKind::NetworkUnreachable,
            ErrorKind::HostUnreachable,
            ErrorKind::NetworkDown,
        ] {
            let receiver = tokio::net::UdpSocket::bind("127.0.0.1:0").await?;
            let route = Arc::new(RouteFailureConn {
                socket: tokio::net::UdpSocket::bind("127.0.0.1:0").await?,
                failure: std::sync::Mutex::new(Some(kind)),
            });
            let candidate = |port, conn| {
                CandidateHostConfig {
                    base_config: CandidateBaseConfig {
                        network: "udp".into(),
                        address: "127.0.0.1".into(),
                        port,
                        component: 1,
                        conn,
                        ..Default::default()
                    },
                    ..Default::default()
                }
                .new_candidate_host()
                .map(Arc::new)
            };
            let pair = Arc::new(CandidatePair::new(
                candidate(route.socket.local_addr()?.port(), Some(route.clone()))?,
                candidate(receiver.local_addr()?.port(), None)?,
                true,
            ));
            let conn = AgentConn::new();
            if selected {
                conn.selected_pair.store(Some(pair));
            } else {
                conn.checklist.lock().await.push(pair);
            }
            assert_eq!(conn.send(b"retry me").await?, 0, "{kind:?}");
            assert!(!conn.done.load(Ordering::SeqCst));
            // The next send uses the same ICE connection and reaches a real
            // UDP receiver. A lost datagram must not poison the association.
            assert_eq!(conn.send(b"retry me").await?, 8);
            let mut buf = [0; 32];
            let n = tokio::time::timeout(Duration::from_secs(1), receiver.recv(&mut buf))
                .await
                .expect("datagram after route recovery")?;
            assert_eq!(&buf[..n], b"retry me");

            for fatal in [ErrorKind::PermissionDenied, ErrorKind::BrokenPipe] {
                *route.failure.lock().unwrap() = Some(fatal);
                assert!(conn.send(b"fail closed").await.is_err(), "{fatal:?}");
            }
            conn.done.store(true, Ordering::SeqCst);
            assert!(conn.send(b"closed").await.is_err());
        }
    }
    Ok(())
}

#[cfg(windows)]
#[test]
fn winsock_unreachable_error_has_the_classified_network_kind() {
    assert_eq!(
        std::io::Error::from_raw_os_error(10051).kind(),
        std::io::ErrorKind::NetworkUnreachable
    );
}

pub(crate) async fn pipe(
    default_config0: Option<AgentConfig>,
    default_config1: Option<AgentConfig>,
) -> Result<(Arc<impl Conn>, Arc<impl Conn>, Arc<Agent>, Arc<Agent>)> {
    let (a_notifier, mut a_connected) = on_connected();
    let (b_notifier, mut b_connected) = on_connected();

    let mut cfg0 = default_config0.unwrap_or_default();
    cfg0.urls = vec![];
    cfg0.network_types = supported_network_types();

    let a_agent = Arc::new(Agent::new(cfg0).await?);
    a_agent.on_connection_state_change(a_notifier);

    let mut cfg1 = default_config1.unwrap_or_default();
    cfg1.urls = vec![];
    cfg1.network_types = supported_network_types();

    let b_agent = Arc::new(Agent::new(cfg1).await?);
    b_agent.on_connection_state_change(b_notifier);

    let (a_conn, b_conn) = connect_with_vnet(&a_agent, &b_agent).await?;

    // Ensure pair selected
    // Note: this assumes ConnectionStateConnected is thrown after selecting the final pair
    let _ = a_connected.recv().await;
    let _ = b_connected.recv().await;

    Ok((a_conn, b_conn, a_agent, b_agent))
}

#[tokio::test]
async fn test_remote_local_addr() -> Result<()> {
    // Agent0 is behind 1:1 NAT
    let nat_type0 = nat::NatType {
        mode: nat::NatMode::Nat1To1,
        ..Default::default()
    };
    // Agent1 is behind 1:1 NAT
    let nat_type1 = nat::NatType {
        mode: nat::NatMode::Nat1To1,
        ..Default::default()
    };

    let v = build_vnet(nat_type0, nat_type1).await?;

    let stun_server_url = Url {
        scheme: SchemeType::Stun,
        host: VNET_STUN_SERVER_IP.to_owned(),
        port: VNET_STUN_SERVER_PORT,
        proto: ProtoType::Udp,
        ..Default::default()
    };

    //"Disconnected Returns nil"
    {
        let disconnected_conn = AgentConn::new();
        let result = disconnected_conn.local_addr();
        assert!(result.is_err(), "Disconnected Returns nil");
    }

    //"Remote/Local Pair Match between Agents"
    {
        let (ca, cb) = pipe_with_vnet(
            &v,
            AgentTestConfig {
                urls: vec![stun_server_url.clone()],
                ..Default::default()
            },
            AgentTestConfig {
                urls: vec![stun_server_url],
                ..Default::default()
            },
        )
        .await?;

        let a_laddr = ca.local_addr()?;
        let b_laddr = cb.local_addr()?;

        // Assert addresses
        assert_eq!(a_laddr.ip().to_string(), VNET_LOCAL_IPA.to_string());
        assert_eq!(b_laddr.ip().to_string(), VNET_LOCAL_IPB.to_string());

        // Close
        //ca.close().await?;
        //cb.close().await?;
    }

    v.close().await?;

    Ok(())
}

#[tokio::test]
async fn test_conn_stats() -> Result<()> {
    let (ca, cb, _, _) = pipe(None, None).await?;
    let na = ca.send(&[0u8; 10]).await?;

    let wg = WaitGroup::new();

    let w = wg.worker();
    tokio::spawn(async move {
        let _d = w;

        let mut buf = vec![0u8; 10];
        let nb = cb.recv(&mut buf).await?;
        assert_eq!(nb, 10, "bytes received don't match");

        Result::<()>::Ok(())
    });

    wg.wait().await;

    assert_eq!(na, 10, "bytes sent don't match");

    Ok(())
}
